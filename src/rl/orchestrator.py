"""RL Orchestrator — wires RewardModel, ExperienceBuffer, Feedback,
GoalSetter, KnowledgeConsolidator, and MetricsExporter together.

This is the single integration point that the pipeline (_core.py) and
bot handlers call. It provides high-level methods:

- on_pipeline_complete(episode_data) → RewardSignal
- on_user_feedback(feedback) → None
- on_idle() → runs consolidation + goal analysis
- get_training_ready_data() → SFT/DPO datasets

All modules are lazily initialized; the orchestrator doesn't do heavy
work on import.
"""

from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

import structlog

from src.rl.reward_model import RewardModel, TaskReward, TaskType, RewardSignal
from src.rl.experience_buffer import ExperienceReplayBuffer, Experience
from src.rl.feedback_collector import FeedbackCollector, UserFeedback, FeedbackType
from src.rl.goal_setter import GoalSetter, Goal
from src.rl.knowledge_consolidator import KnowledgeConsolidator
from src.rl.metrics_exporter import MetricsExporter

logger = structlog.get_logger("RLOrchestrator")


class RLOrchestrator:
    """Central RL subsystem coordinator.

    Usage:
        rl = RLOrchestrator(data_dir="data/rl")
        rl.initialize()

        # After pipeline execution:
        signal = rl.on_pipeline_complete(
            episode_id="ep1",
            task_type="code_gen",
            success=True,
            auditor_score=0.85,
            latency_ms=2300,
            steps=[...],
        )

        # After user feedback:
        rl.on_user_feedback(UserFeedback(
            message_id="msg456",
            episode_id="ep1",
            feedback_type=FeedbackType.THUMBS_UP,
        ))

        # Periodic idle maintenance:
        rl.on_idle()

        # Export training data:
        rl.export_training_data()
    """

    def __init__(
        self,
        data_dir: str = "data/rl",
        supermemory_db: str = "data/supermemory/supermemory.db",
    ) -> None:
        self._data_dir = data_dir
        self._supermemory_db = supermemory_db

        # Lazy-init components
        self.reward_model = RewardModel()
        self.experience_buffer = ExperienceReplayBuffer(
            db_path=os.path.join(data_dir, "experiences.db"),
        )
        self.feedback = FeedbackCollector(
            db_path=os.path.join(data_dir, "feedback.db"),
        )
        self.goals = GoalSetter(
            db_path=os.path.join(data_dir, "goals.db"),
        )
        self.consolidator = KnowledgeConsolidator(
            supermemory_db=supermemory_db,
            consolidation_db=os.path.join(data_dir, "consolidation.db"),
        )
        self.metrics = MetricsExporter()

        self._initialized = False
        self._last_consolidation = 0.0
        self._consolidation_interval = 3600.0  # 1 hour

    def initialize(self) -> None:
        """Initialize all RL components."""
        os.makedirs(self._data_dir, exist_ok=True)
        self.experience_buffer.initialize()
        self.feedback.initialize()
        self.goals.initialize()
        self.consolidator.initialize()
        self._initialized = True
        logger.info("RLOrchestrator initialized", data_dir=self._data_dir)

    # ------------------------------------------------------------------
    # Pipeline integration
    # ------------------------------------------------------------------

    def on_pipeline_complete(
        self,
        episode_id: str,
        task_type: str = "general",
        success: bool = False,
        auditor_score: float = 0.5,
        latency_ms: float = 0.0,
        input_tokens: int = 0,
        output_tokens: int = 0,
        retries: int = 0,
        tool_calls: int = 0,
        tool_success_rate: float = 1.0,
        error_type: Optional[str] = None,
        steps: Optional[List[Dict[str, Any]]] = None,
    ) -> RewardSignal:
        """Called after each pipeline execution. Computes reward and stores experience.

        Returns the computed RewardSignal for the caller's reference.
        """
        self._ensure_init()

        # Map string to TaskType enum
        try:
            tt = TaskType(task_type)
        except ValueError:
            tt = TaskType.GENERAL

        # Check if user feedback already exists for this episode
        user_rating = None
        fb_list = self.feedback.get_episode_feedback(episode_id)
        if fb_list:
            scores = [fb.normalized_score for fb in fb_list]
            user_rating = sum(scores) / len(scores)

        # Compute reward
        task = TaskReward(
            task_id=episode_id,
            task_type=tt,
            success=success,
            user_rating=user_rating,
            auditor_score=auditor_score,
            latency_ms=latency_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            retries=retries,
            tool_calls=tool_calls,
            tool_success_rate=tool_success_rate,
            error_type=error_type,
        )
        signal = self.reward_model.compute(task)

        # Store each step as an experience
        if steps:
            experiences = []
            n_steps = len(steps)
            for i, step in enumerate(steps):
                # Discount reward: earlier steps get less credit
                discount = 0.99 ** (n_steps - 1 - i)
                exp = Experience(
                    episode_id=episode_id,
                    step_index=i,
                    role=step.get("role", ""),
                    task_type=task_type,
                    state_prompt=step.get("prompt", "")[:10_000],
                    state_memory=step.get("memory_context", "")[:5_000],
                    action_response=step.get("response", "")[:10_000],
                    action_model=step.get("model", ""),
                    action_tokens=step.get("tokens", 0),
                    action_latency_ms=step.get("latency_ms", 0.0),
                    reward=round(signal.total * discount, 4),
                    reward_components=signal.components,
                    success=success,
                    metadata={"episode_reward": signal.total},
                )
                experiences.append(exp)
            self.experience_buffer.add_batch(experiences)
        else:
            # Single-step experience
            exp = Experience(
                episode_id=episode_id,
                task_type=task_type,
                reward=signal.total,
                reward_components=signal.components,
                success=success,
            )
            self.experience_buffer.add(exp)

        # Update metrics
        self.metrics.record_reward(signal.total, task_type)
        self.metrics.record_pipeline_latency(latency_ms)

        buf_stats = self.experience_buffer.get_stats()
        self.metrics.update_buffer_stats(
            buf_stats.get("total", 0),
            buf_stats.get("successful", 0),
        )

        logger.info(
            "pipeline_episode_recorded",
            episode_id=episode_id,
            reward=signal.total,
            task_type=task_type,
            success=success,
        )
        return signal

    def on_user_feedback(self, fb: UserFeedback) -> None:
        """Called when user provides feedback on a bot response."""
        self._ensure_init()
        self.feedback.record(fb)
        self.metrics.record_feedback(fb.feedback_type.value, fb.channel)

        # If we have the episode_id, retroactively update the experience reward
        if fb.episode_id:
            trajectory = self.experience_buffer.get_episode_trajectory(fb.episode_id)
            if trajectory:
                logger.info(
                    "feedback_enriches_experience",
                    episode_id=fb.episode_id,
                    score=fb.normalized_score,
                    steps=len(trajectory),
                )
                # The reward will be recalculated on next pipeline use via
                # the feedback collector's aggregate score

    def on_router_outcome(
        self, model: str, task_type: str, success: bool, quality: float
    ) -> None:
        """Called after each LLM call to track router metrics."""
        self.metrics.record_router_outcome(model, task_type, success, quality)

    # ------------------------------------------------------------------
    # Idle maintenance
    # ------------------------------------------------------------------

    def on_idle(self, force: bool = False) -> Dict[str, Any]:
        """Run periodic maintenance tasks. Returns summary of actions taken.

        Called during idle periods (no active pipeline execution).
        Runs at most once per consolidation_interval.
        """
        self._ensure_init()
        now = time.time()

        if not force and (now - self._last_consolidation < self._consolidation_interval):
            return {"skipped": True, "reason": "too_soon"}

        self._last_consolidation = now
        results: Dict[str, Any] = {}

        # 1. Knowledge consolidation
        try:
            consolidation = self.consolidator.run_consolidation()
            results["consolidation"] = {
                "facts_extracted": consolidation.facts_extracted,
                "dupes_merged": consolidation.duplicates_merged,
                "demoted": consolidation.memories_demoted,
                "elapsed": consolidation.elapsed_sec,
            }
            self.metrics.record_consolidation(consolidation.elapsed_sec)
        except Exception as e:
            logger.warning("consolidation_failed", error=str(e))
            results["consolidation"] = {"error": str(e)}

        # 2. Update goal stats
        try:
            goal_stats = self.goals.get_stats()
            self.metrics.update_goal_stats(goal_stats.get("by_status", {}))
            results["goals"] = goal_stats
        except Exception as e:
            logger.warning("goal_stats_failed", error=str(e))

        logger.info("idle_maintenance_complete", results=results)
        return results

    # ------------------------------------------------------------------
    # Training data export
    # ------------------------------------------------------------------

    def export_training_data(self, output_dir: Optional[str] = None) -> Dict[str, Any]:
        """Export data ready for training. Returns paths and counts.

        Creates:
        - sft_data.jsonl — successful experiences for supervised fine-tuning
        - dpo_pairs.jsonl — preference pairs (chosen vs rejected)
        - corrections.jsonl — user corrections as training signal
        """
        self._ensure_init()
        out = output_dir or os.path.join(self._data_dir, "training_export")
        os.makedirs(out, exist_ok=True)

        sft_path = os.path.join(out, "sft_data.jsonl")
        dpo_path = os.path.join(out, "dpo_pairs.jsonl")

        sft_count = self.experience_buffer.export_sft_jsonl(sft_path, min_reward=0.5)
        dpo_count = self.experience_buffer.export_dpo_pairs(dpo_path, min_gap=0.3)

        # Export corrections
        corrections = self.feedback.get_corrections(limit=500)
        corrections_path = os.path.join(out, "corrections.jsonl")
        import json
        with open(corrections_path, "w", encoding="utf-8") as f:
            for c in corrections:
                f.write(json.dumps({
                    "message_id": c.message_id,
                    "correction": c.correction,
                    "comment": c.comment,
                    "timestamp": c.timestamp,
                }, ensure_ascii=False) + "\n")

        result = {
            "output_dir": out,
            "sft_count": sft_count,
            "dpo_pairs_count": dpo_count,
            "corrections_count": len(corrections),
            "sft_path": sft_path,
            "dpo_path": dpo_path,
            "corrections_path": corrections_path,
        }
        logger.info("training_data_exported", **result)
        return result

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    def status(self) -> Dict[str, Any]:
        """Get comprehensive RL subsystem status."""
        self._ensure_init()
        return {
            "reward_model": self.reward_model.get_stats(),
            "experience_buffer": self.experience_buffer.get_stats(),
            "feedback": self.feedback.get_stats(),
            "goals": self.goals.get_stats(),
            "consolidation_history": self.consolidator.get_history(limit=5),
            "metrics_snapshot": self.metrics.snapshot(),
        }

    def _ensure_init(self) -> None:
        if not self._initialized:
            self.initialize()
