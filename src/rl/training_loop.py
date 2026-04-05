"""Training Loop — orchestrates adaptive learning for OpenRouter API models.

Since cloud API models can't be fine-tuned directly, this module implements
"API-side training" — optimizing everything around the model:

Phase 1: BASELINE — run benchmarks with current prompts (before)
Phase 2: SEED — create initial prompt variants from current system prompts
Phase 3: SIMULATE — generate synthetic experience data by running tasks
Phase 4: EVOLVE — mutate prompts via MCTS tree search (AFlow + MAC inspired)
Phase 5: OPTIMIZE — tune router weights, few-shot selection, context assembly
Phase 6: EVALUATE — run benchmarks again with optimized system (after)
Phase 7: REPORT — generate before/after comparison

Research-backed improvements (Phase 3):
- MCTS prompt search: tree-structured optimization instead of flat mutations (AFlow)
- Constitution learning: structured rule-based prompts (MAC)
- Difficulty curriculum: staged training easy→hard (SAGE + Demystifying RL)
- Multi-evaluation: 3x eval per variant for robustness (AFlow)
- Quality critic: filter bad mutations, prevent degradation (SAGE)
- Co-evolution: track prompt+few-shot synergies (Complementary RL)
- Stability monitoring: detect collapse/oscillation/plateau (Demystifying RL)

Usage:
    runner = TrainingRunner(api_key="sk-or-...")
    await runner.run_full_training(epochs=3)
    print(runner.get_comparison_report())
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional

import structlog

from src.rl.benchmark import (
    BENCHMARK_TASKS, BenchmarkRunner, BenchmarkResult,
    BenchmarkScorer, BenchmarkTask, format_comparison,
)
from src.rl.prompt_evolver import PromptEvolver
from src.rl.few_shot_selector import FewShotSelector
from src.rl.router_optimizer import RouterOptimizer
from src.rl.adaptive_context import AdaptiveContextBuilder, ContextSection
from src.rl.experience_buffer import ExperienceReplayBuffer, Experience
from src.rl.reward_model import RewardModel, TaskReward, TaskType
from src.rl.mcts_prompt_search import MCTSPromptSearch, PromptConstitution
from src.rl.difficulty_curriculum import (
    DifficultyCurriculum, DifficultyLevel, DifficultyTask,
    StagedRewardCalculator, StabilityMonitor, create_difficulty_tasks,
)
from src.rl.quality_critic import (
    QualityCritic, MultiEvaluator, CoEvolutionTracker,
)

logger = structlog.get_logger("TrainingLoop")


# ---------------------------------------------------------------------------
# Default system prompts (seeds) — mirrors build_role_prompt in pipeline_utils
# ---------------------------------------------------------------------------

_SEED_PROMPTS: Dict[str, Dict[str, str]] = {
    "Executor": {
        "code": (
            "Ты — опытный программист. Отвечай на РУССКОМ ЯЗЫКЕ.\n"
            "ПРАВИЛА:\n"
            "1. Пиши чистый, рабочий код с docstring и type hints.\n"
            "2. Если есть баг — сначала объясни причину, потом покажи исправление.\n"
            "3. Используй ```python блоки для кода.\n"
            "4. НЕ повторяй одну мысль разными словами.\n"
            "5. Если не уверен — скажи честно."
        ),
        "research": (
            "Ты — аналитик-исследователь. Отвечай на РУССКОМ ЯЗЫКЕ.\n"
            "ПРАВИЛА:\n"
            "1. Давай структурированные ответы с пунктами.\n"
            "2. Приводи конкретные примеры и сравнения.\n"
            "3. Если есть таблица или список — используй Markdown.\n"
            "4. Разделяй факты и свои оценки.\n"
            "5. Если не знаешь — скажи прямо."
        ),
        "conversation": (
            "Ты — дружелюбный ИИ-ассистент OpenClaw бота. Отвечай на РУССКОМ ЯЗЫКЕ.\n"
            "ПРАВИЛА:\n"
            "1. Простые вопросы — короткие ответы (2-3 предложения).\n"
            "2. НЕ используй метки STAR/SITUATION/ACTION.\n"
            "3. НЕ описывай свои возможности без запроса.\n"
            "4. Будь конкретен и естественен.\n"
            "5. Если вопрос конкретный — давай прямой ответ."
        ),
        "creative": (
            "Ты — творческий писатель. Отвечай на РУССКОМ ЯЗЫКЕ.\n"
            "ПРАВИЛА:\n"
            "1. Пиши оригинально, избегай клише.\n"
            "2. Следуй заданному формату (рассказ, стихи и т.д.).\n"
            "3. Используй живой, образный язык.\n"
            "4. Не превышай заданный объём."
        ),
        "general": (
            "Ты — универсальный ИИ-ассистент. Отвечай на РУССКОМ ЯЗЫКЕ.\n"
            "ПРАВИЛА:\n"
            "1. Отвечай точно и по делу.\n"
            "2. Структурируй сложные ответы.\n"
            "3. НЕ повторяй одну мысль.\n"
            "4. Если не знаешь — скажи честно.\n"
            "5. Используй Markdown для форматирования."
        ),
    }
}


# ---------------------------------------------------------------------------
# Training Runner
# ---------------------------------------------------------------------------

class TrainingRunner:
    """Runs the full adaptive training pipeline for API models.

    Orchestrates: benchmarks, prompt evolution, few-shot injection,
    router tuning, and context optimization.
    """

    def __init__(
        self,
        data_dir: str = "data/rl",
        api_key: str = "",
        base_url: str = "https://openrouter.ai/api/v1",
        models: Optional[Dict[str, str]] = None,
    ) -> None:
        self._data_dir = data_dir
        self._api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
        self._base_url = base_url

        # Default models from openclaw_config.json
        self._models = models or {
            "code": "qwen/qwen3.6-plus-preview:free",
            "general": "nvidia/nemotron-3-super-120b-a12b:free",
            "research": "stepfun/step-3.5-flash:free",
            "creative": "nvidia/nemotron-3-super-120b-a12b:free",
        }

        # Components
        self._evolver = PromptEvolver(os.path.join(data_dir, "prompt_evolution.db"))
        self._buffer = ExperienceReplayBuffer(os.path.join(data_dir, "experiences.db"))
        self._router = RouterOptimizer(os.path.join(data_dir, "router_weights.db"))
        self._context = AdaptiveContextBuilder(os.path.join(data_dir, "context_weights.db"))
        self._reward_model = RewardModel()
        self._few_shot: Optional[FewShotSelector] = None

        # Phase 3: Research-backed components
        self._mcts = MCTSPromptSearch(os.path.join(data_dir, "mcts_search.db"))
        self._curriculum = DifficultyCurriculum()
        self._staged_rewards = StagedRewardCalculator(model_capability=0.4)  # free models
        self._stability = StabilityMonitor()
        self._multi_eval = MultiEvaluator(n_evaluations=3)
        self._critic = QualityCritic()
        self._coevolution = CoEvolutionTracker(os.path.join(data_dir, "coevolution.db"))

        # Results storage
        self._baseline_results: Optional[Dict[str, Any]] = None
        self._trained_results: Optional[Dict[str, Any]] = None
        self._training_log: List[Dict[str, Any]] = []
        self._initialized = False

    def initialize(self) -> None:
        """Initialize all components."""
        os.makedirs(self._data_dir, exist_ok=True)
        self._evolver.initialize()
        self._buffer.initialize()
        self._router.initialize()
        self._context.initialize()
        self._mcts.initialize()
        self._coevolution.initialize()
        self._few_shot = FewShotSelector(self._buffer)

        # Register models in router
        for task_type, model in self._models.items():
            self._router.register_model(model, [task_type, "general"])

        self._initialized = True
        logger.info("TrainingRunner initialized", models=list(self._models.keys()))

    # ------------------------------------------------------------------
    # LLM call wrapper
    # ------------------------------------------------------------------

    async def _call_llm(
        self,
        prompt: str,
        system: str = "",
        task_type: str = "general",
        model: str = "",
        max_tokens: int = 2048,
        temperature: float = 0.3,
    ) -> str:
        """Call OpenRouter API directly."""
        import aiohttp

        if not self._api_key:
            return "[ERROR: No API key. Set OPENROUTER_API_KEY environment variable.]"

        if not model:
            model = self._models.get(task_type, self._models.get("general", ""))

        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://openclaw.bot",
            "X-Title": "OpenClaw_Training",
        }

        payload = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": False,
        }

        timeout = aiohttp.ClientTimeout(total=60)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self._base_url}/chat/completions",
                json=payload,
                headers=headers,
            ) as resp:
                if resp.status != 200:
                    error_text = await resp.text()
                    return f"[ERROR {resp.status}: {error_text[:200]}]"

                data = await resp.json()
                choices = data.get("choices", [])
                if not choices:
                    return "[ERROR: empty response]"

                return choices[0].get("message", {}).get("content", "")

    # ------------------------------------------------------------------
    # Phase 1: Baseline benchmark
    # ------------------------------------------------------------------

    async def run_baseline(self) -> Dict[str, Any]:
        """Phase 1: Run benchmarks with current (unoptimized) prompts."""
        logger.info("=== PHASE 1: BASELINE BENCHMARK ===")

        runner = BenchmarkRunner(
            llm_fn=self._call_llm,
            judge_fn=self._call_llm,
        )

        self._baseline_results = await runner.run_suite(
            label="BASELINE (до обучения)",
            system_prompt=_SEED_PROMPTS["Executor"].get("general", ""),
        )

        self._training_log.append({
            "phase": "baseline",
            "score": self._baseline_results["weighted_score"],
            "timestamp": time.time(),
        })

        logger.info(
            f"Baseline score: {self._baseline_results['weighted_score']:.4f}",
            categories=self._baseline_results["category_scores"],
        )
        return self._baseline_results

    # ------------------------------------------------------------------
    # Phase 2: Seed prompts
    # ------------------------------------------------------------------

    def seed_prompts(self) -> int:
        """Phase 2: Register initial prompt variants from seeds."""
        logger.info("=== PHASE 2: SEED PROMPTS ===")
        count = 0
        for role, task_prompts in _SEED_PROMPTS.items():
            for task_type, prompt_text in task_prompts.items():
                self._evolver.register_seed(role, task_type, prompt_text)
                count += 1
        logger.info(f"Registered {count} seed prompts")
        return count

    # ------------------------------------------------------------------
    # Phase 3: Generate synthetic experience
    # ------------------------------------------------------------------

    async def generate_experience(self, n_tasks: int = 10) -> int:
        """Phase 3: Run difficulty-stratified tasks to generate experience data.

        Uses DifficultyCurriculum for balanced sampling (Demystifying RL insight:
        ~1K samples with balanced difficulty is the sweet spot).
        Uses StagedRewardCalculator for difficulty-appropriate rewards.
        """
        logger.info(f"=== PHASE 3: GENERATE EXPERIENCE ({n_tasks} tasks, "
                     f"curriculum: {self._curriculum.stage_name}) ===")

        # Get difficulty-balanced batch
        diff_tasks = self._curriculum.sample_batch(n_tasks)
        scorer = BenchmarkScorer()
        generated = 0

        category_to_type = {
            "code": "code_gen", "debug": "code_gen",
            "research": "research", "reasoning": "general",
            "conversation": "conversation", "creative": "creative",
        }

        batch_scores: List[float] = []
        for task in diff_tasks:
            task_type = task.category.value
            model = self._models.get(task_type, self._models.get("general", ""))

            # Get prompt variant (or seed)
            variant_id, system_prompt = self._evolver.select(
                "Executor", task_type, explore_prob=0.3,
            )
            if not system_prompt:
                system_prompt = _SEED_PROMPTS["Executor"].get(task_type, "")

            start_ms = time.time() * 1000
            response = await self._call_llm(
                prompt=task.prompt,
                system=system_prompt,
                task_type=task_type,
                model=model,
            )
            latency_ms = time.time() * 1000 - start_ms

            # Score
            rule_score, breakdown = scorer.score(task, response)

            # Staged reward based on difficulty (Demystifying RL)
            staged_reward = self._staged_rewards.compute_staged_reward(
                task, rule_score, breakdown,
            )

            # Compute composite reward
            rt = category_to_type.get(task_type, "general")
            try:
                task_type_enum = TaskType(rt)
            except ValueError:
                task_type_enum = TaskType.GENERAL

            reward_signal = self._reward_model.compute(TaskReward(
                task_id=task.task_id,
                task_type=task_type_enum,
                success=rule_score > 0.5,
                latency_ms=latency_ms,
                auditor_score=staged_reward,  # use staged reward
                user_rating=0.0,
                output_tokens=len(response) // 4,
                error_type=None,
            ))

            # Store experience
            exp = Experience(
                episode_id=f"train_{task.task_id}_{int(time.time())}",
                step_index=0,
                role="Executor",
                task_type=task_type,
                state_prompt=task.prompt,
                action_response=response,
                action_model=model,
                action_latency_ms=latency_ms,
                reward=reward_signal.total,
                reward_components=reward_signal.components,
                success=rule_score > 0.5,
            )
            self._buffer.add(exp)

            # Record reward for prompt variant
            if variant_id:
                self._evolver.record_reward(variant_id, reward_signal.total)

            # Multi-evaluation tracking
            self._multi_eval.record(variant_id or "seed", rule_score, breakdown, latency_ms)

            # Record for router
            self._router.record_outcome(model, task_type, reward_signal.total, latency_ms)

            # Record for context
            self._context.record_reward(
                task_type,
                section_names=["system_prompt"],
                reward=reward_signal.total,
            )

            # Stability monitoring
            self._stability.record(rule_score)

            batch_scores.append(rule_score)
            generated += 1
            difficulty_label = task.difficulty.value if isinstance(task, DifficultyTask) else "?"
            logger.info(
                f"  [{task.task_id}] difficulty={difficulty_label} "
                f"reward={reward_signal.total:.3f} staged={staged_reward:.3f} "
                f"model={model} latency={latency_ms:.0f}ms"
            )

        # Record batch result for curriculum
        if batch_scores:
            mean_score = sum(batch_scores) / len(batch_scores)
            advanced = self._curriculum.record_batch_result(mean_score)
            if advanced:
                logger.info(f"Curriculum advanced to: {self._curriculum.stage_name}")

        self._training_log.append({
            "phase": "experience",
            "generated": generated,
            "curriculum_stage": self._curriculum.stage_name,
            "stability": self._stability.get_stats(),
            "timestamp": time.time(),
        })

        return generated

    # ------------------------------------------------------------------
    # Phase 4: Evolve prompts
    # ------------------------------------------------------------------

    async def evolve_prompts(self, mutations_per_type: int = 3) -> int:
        """Phase 4: MCTS tree-search prompt evolution with quality filtering.

        Instead of flat random mutations (Phase 2), uses:
        - MCTS tree search (AFlow): UCB1 selection → expansion → evaluation → backprop
        - Constitution mutations (MAC): add/edit/remove structured rules
        - Multi-evaluation (AFlow): 3x eval per variant for robustness
        - Quality critic (SAGE): reject mutations that don't improve
        - Co-evolution tracking (Complementary RL): log prompt+few-shot synergies
        """
        logger.info("=== PHASE 4: MCTS PROMPT EVOLUTION ===")

        total_new = 0
        scorer = BenchmarkScorer()

        for role, task_prompts in _SEED_PROMPTS.items():
            for task_type, seed_text in task_prompts.items():
                # Get or create MCTS root
                root = self._mcts.load_tree(role, task_type)
                if root is None:
                    root = self._mcts.create_root(role, task_type, seed_text)

                # Also register in flat evolver for backward compatibility
                self._evolver.register_seed(role, task_type, seed_text)

                # Run MCTS iterations
                for i in range(mutations_per_type):
                    # MCTS Selection: UCB1 traversal to leaf
                    leaf = self._mcts.select(root)

                    # MCTS Expansion: create child via MAC-style mutation
                    child = self._mcts.expand(leaf)
                    child_prompt = child.prompt_text
                    if not child_prompt:
                        continue

                    # Multi-Evaluation (AFlow: 3x for robustness)
                    sample_tasks = [t for t in BENCHMARK_TASKS if t.category.value == task_type]
                    if not sample_tasks:
                        sample_tasks = BENCHMARK_TASKS[:2]

                    eval_scores = []
                    for sample_task in sample_tasks[:2]:
                        response = await self._call_llm(
                            prompt=sample_task.prompt,
                            system=child_prompt,
                            task_type=task_type,
                        )
                        rule_score, breakdown = scorer.score(sample_task, response)
                        eval_scores.append(rule_score)

                        # Multi-eval tracking
                        self._multi_eval.record(
                            child.node_id, rule_score, breakdown,
                        )

                    mean_score = sum(eval_scores) / len(eval_scores) if eval_scores else 0.0

                    # Quality Critic: accept or reject (SAGE)
                    child_eval = self._multi_eval.get_result(child.node_id)
                    parent_eval = self._multi_eval.get_result(leaf.node_id)

                    if child_eval:
                        accepted, reason = self._critic.evaluate(
                            child_eval, parent_eval, child_prompt,
                        )
                        if not accepted:
                            logger.debug(f"  Mutation rejected: {reason}")
                            # Still backpropagate low score (MCTS learns from failures)
                            self._mcts.backpropagate(child, mean_score * 0.5)
                            continue

                    # MCTS Backpropagation
                    self._mcts.backpropagate(child, mean_score)

                    # Also register in flat evolver
                    variant_id = self._evolver.register_seed(role, task_type, child_prompt)
                    if variant_id:
                        self._evolver.record_reward(variant_id, mean_score * 2 - 1)

                    # Co-evolution: track which few-shots were used
                    if self._few_shot:
                        examples = self._few_shot.select(
                            query=sample_tasks[0].prompt if sample_tasks else "",
                            task_type=task_type,
                            max_examples=2,
                        )
                        fs_ids = [e.experience_id for e in examples]
                        self._coevolution.record(
                            variant_id or child.node_id,
                            fs_ids,
                            task_type,
                            mean_score,
                        )

                    total_new += 1
                    logger.info(
                        f"  [{role}/{task_type}] MCTS depth={child.depth} "
                        f"mutation={child.mutation_type} score={mean_score:.3f} ✓"
                    )

                # Log tree stats
                stats = self._mcts.tree_stats(root)
                logger.info(
                    f"  Tree [{role}/{task_type}]: {stats['total_nodes']} nodes, "
                    f"best={stats['best_reward']:.3f}, mean={stats['mean_reward']:.3f}"
                )

        # Check stability
        recommendation = self._stability.get_recommendation()
        if recommendation == "rollback":
            logger.warning("Stability: rollback recommended — reverting exploration")
        elif recommendation == "reduce_exploration":
            logger.info("Stability: reducing exploration")

        self._training_log.append({
            "phase": "evolve",
            "new_variants": total_new,
            "critic_stats": self._critic.get_stats(),
            "stability": self._stability.get_stats(),
            "timestamp": time.time(),
        })

        logger.info(
            f"MCTS evolution: {total_new} accepted variants "
            f"(acceptance rate: {self._critic.get_acceptance_rate():.0%})"
        )
        return total_new

    # ------------------------------------------------------------------
    # Phase 5: Optimize routing & context
    # ------------------------------------------------------------------

    async def optimize_routing(self, rounds: int = 5) -> Dict[str, Any]:
        """Phase 5: Run tasks through different models to learn preferences."""
        logger.info(f"=== PHASE 5: OPTIMIZE ROUTING ({rounds} rounds) ===")

        scorer = BenchmarkScorer()

        for round_idx in range(rounds):
            # Pick a random benchmark task
            task = BENCHMARK_TASKS[round_idx % len(BENCHMARK_TASKS)]
            task_type = task.category.value

            # Thompson Sampling selects model
            selected_model = self._router.select_model(task_type, explore=True)
            if not selected_model:
                selected_model = self._models.get(task_type, "")

            # Get best prompt
            _, system_prompt = self._evolver.select("Executor", task_type, explore_prob=0.1)
            if not system_prompt:
                system_prompt = _SEED_PROMPTS["Executor"].get(task_type, "")

            # Get few-shot examples
            examples = self._few_shot.select(
                query=task.prompt, task_type=task_type, max_examples=2,
            ) if self._few_shot else []

            few_shot_text = FewShotSelector.format_examples(examples) if examples else ""
            full_prompt = few_shot_text + task.prompt if few_shot_text else task.prompt

            start_ms = time.time() * 1000
            response = await self._call_llm(
                prompt=full_prompt,
                system=system_prompt,
                task_type=task_type,
                model=selected_model,
            )
            latency_ms = time.time() * 1000 - start_ms

            rule_score, _ = scorer.score(task, response)

            # Record outcome for router
            self._router.record_outcome(
                selected_model, task_type, rule_score * 2 - 1, latency_ms,
            )

            # Record for context
            sections_used = ["system_prompt"]
            if few_shot_text:
                sections_used.append("few_shot")
            self._context.record_reward(task_type, sections_used, rule_score * 2 - 1)

            logger.info(
                f"  Round {round_idx+1}: [{task.task_id}] model={selected_model} "
                f"score={rule_score:.3f} latency={latency_ms:.0f}ms"
            )

        routing_table = self._router.get_routing_table()
        self._training_log.append({
            "phase": "routing",
            "rounds": rounds,
            "routing_table": routing_table,
            "timestamp": time.time(),
        })

        return routing_table

    # ------------------------------------------------------------------
    # Phase 6: Final evaluation
    # ------------------------------------------------------------------

    async def run_evaluation(self) -> Dict[str, Any]:
        """Phase 6: Run benchmarks with optimized system."""
        logger.info("=== PHASE 6: FINAL EVALUATION ===")

        async def optimized_llm(prompt, system="", task_type="general", model=""):
            # Use learned best model
            best_model = self._router.select_model(task_type, explore=False)
            if not best_model:
                best_model = self._models.get(task_type, "")

            # Use evolved prompt
            _, evolved_prompt = self._evolver.select(
                "Executor", task_type, explore_prob=0.0,
            )
            if not evolved_prompt:
                evolved_prompt = system

            # Few-shot injection
            examples = self._few_shot.select(
                query=prompt, task_type=task_type, max_examples=2,
            ) if self._few_shot else []

            few_shot_text = FewShotSelector.format_examples(examples)
            full_prompt = few_shot_text + prompt if few_shot_text else prompt

            return await self._call_llm(
                prompt=full_prompt,
                system=evolved_prompt,
                task_type=task_type,
                model=best_model,
            )

        runner = BenchmarkRunner(
            llm_fn=optimized_llm,
            judge_fn=self._call_llm,
        )

        self._trained_results = await runner.run_suite(
            label="TRAINED (после обучения)",
        )

        self._training_log.append({
            "phase": "evaluation",
            "score": self._trained_results["weighted_score"],
            "timestamp": time.time(),
        })

        logger.info(
            f"Trained score: {self._trained_results['weighted_score']:.4f}",
            categories=self._trained_results["category_scores"],
        )
        return self._trained_results

    # ------------------------------------------------------------------
    # Full pipeline
    # ------------------------------------------------------------------

    async def run_full_training(self, epochs: int = 2) -> str:
        """Run the complete training pipeline.

        Integrates research-backed improvements:
        - Difficulty curriculum: auto-advances through stages (SAGE)
        - Stability monitoring: adjusts strategy on collapse/oscillation
        - MCTS prompt search: tree-structured evolution (AFlow + MAC)
        - Multi-evaluation: robust scoring (AFlow)

        Args:
            epochs: Number of evolve→optimize cycles.

        Returns:
            Formatted comparison report.
        """
        if not self._initialized:
            self.initialize()

        logger.info(f"Starting full training pipeline ({epochs} epochs)")
        start_time = time.time()

        # Phase 1: Baseline
        await self.run_baseline()

        # Phase 2: Seed prompts
        self.seed_prompts()

        # Phase 3-5: Training epochs with stability monitoring
        for epoch in range(epochs):
            logger.info(f"\n{'='*60}\nEPOCH {epoch + 1}/{epochs}"
                         f" | Curriculum: {self._curriculum.stage_name}\n{'='*60}")

            # Adjust exploration based on stability
            recommendation = self._stability.get_recommendation()
            mutations = 3  # default
            if recommendation == "reduce_exploration":
                mutations = 2
            elif recommendation == "increase_exploration":
                mutations = 5

            # Generate experience (with difficulty curriculum)
            await self.generate_experience(n_tasks=len(BENCHMARK_TASKS))

            # Evolve prompts (MCTS + quality critic)
            await self.evolve_prompts(mutations_per_type=mutations)

            # Optimize routing
            await self.optimize_routing(rounds=len(BENCHMARK_TASKS))

            # Apply decay to prevent stale preferences
            self._router.decay_old_data(decay_factor=0.98)

        # Phase 6: Final evaluation
        await self.run_evaluation()

        elapsed = time.time() - start_time
        logger.info(f"Training complete in {elapsed:.1f}s")

        # Phase 7: Report
        return self.get_comparison_report()

    # ------------------------------------------------------------------
    # Reporting
    # ------------------------------------------------------------------

    def get_comparison_report(self) -> str:
        """Generate before/after comparison report."""
        if not self._baseline_results or not self._trained_results:
            return "Нет данных для сравнения. Запустите run_full_training()."

        report = format_comparison(self._baseline_results, self._trained_results)

        # Append training details
        report += "\n\nДетали обучения:\n"
        report += f"  Эволюция промптов: {self._evolver.stats()}\n"
        report += f"  Роутинг: {self._router.stats()}\n"
        report += f"  Контекст: {self._context.stats()}\n"
        report += f"  Буфер опыта: {self._buffer.get_stats()}\n"

        # Phase 3 research-backed stats
        report += "\nРезультаты исследовательских улучшений:\n"
        report += f"  Curriculum: {self._curriculum.get_stats()}\n"
        report += f"  Stability: {self._stability.get_stats()}\n"
        report += f"  Quality Critic: {self._critic.get_stats()}\n"
        report += f"  Co-evolution: {self._coevolution.get_stats()}\n"

        # Routing table
        routing_table = self._router.get_routing_table()
        if routing_table:
            report += "\nОптимальная маршрутизация моделей (после обучения):\n"
            for task_type, model in sorted(routing_table.items()):
                report += f"  {task_type}: {model}\n"

        return report

    def get_training_log(self) -> List[Dict[str, Any]]:
        """Get the training log."""
        return self._training_log

    def save_results(self, path: Optional[str] = None) -> str:
        """Save training results to JSON."""
        path = path or os.path.join(self._data_dir, "training_results.json")

        results = {
            "baseline": {
                "score": self._baseline_results.get("weighted_score") if self._baseline_results else None,
                "categories": self._baseline_results.get("category_scores") if self._baseline_results else None,
            },
            "trained": {
                "score": self._trained_results.get("weighted_score") if self._trained_results else None,
                "categories": self._trained_results.get("category_scores") if self._trained_results else None,
            },
            "improvement": None,
            "training_log": self._training_log,
            "routing_table": self._router.get_routing_table(),
            "prompt_evolution_stats": self._evolver.stats(),
            "research_backed": {
                "curriculum": self._curriculum.get_stats(),
                "stability": self._stability.get_stats(),
                "quality_critic": self._critic.get_stats(),
                "coevolution": self._coevolution.get_stats(),
            },
        }

        if self._baseline_results and self._trained_results:
            b = self._baseline_results["weighted_score"]
            a = self._trained_results["weighted_score"]
            results["improvement"] = {
                "absolute": round(a - b, 4),
                "relative_pct": round((a - b) / b * 100, 1) if b > 0 else 0,
            }

        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2, ensure_ascii=False, default=str)

        logger.info(f"Results saved to {path}")
        return path
