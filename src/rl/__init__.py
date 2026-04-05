"""RL Subsystem — Reinforcement Learning + Adaptive Training for OpenClaw Bot.

Foundation modules (from Phase 1):
- RewardModel: multi-factor reward computation per task execution
- ExperienceReplayBuffer: persistent (state, action, reward) storage with sampling
- FeedbackCollector: user thumbs-up / thumbs-down collection & aggregation
- GoalSetter: autonomous sub-goal generation from knowledge gaps
- KnowledgeConsolidator: cross-session memory merging & deduplication
- MetricsExporter: Prometheus-compatible metrics from router/pipeline

Adaptive Training modules (Phase 2 — API-model optimization):
- PromptEvolver: evolutionary prompt optimization with ELO rating
- FewShotSelector: dynamic example injection from experience buffer
- RouterOptimizer: Bayesian model selection tuning (Thompson Sampling)
- AdaptiveContextBuilder: learned context assembly for prompts
- BenchmarkRunner: standardized evaluation with before/after comparison
- TrainingRunner: full training pipeline orchestrator

Research-backed Training modules (Phase 3 — arxiv paper-inspired):
- MCTSPromptSearch: tree-structured prompt optimization (AFlow + MAC)
- DifficultyCurriculum: staged training with adaptive difficulty (SAGE + Demystifying RL)
- QualityCritic: multi-evaluation & quality filtering (SAGE + AFlow + Complementary RL)
"""

from src.rl.reward_model import RewardModel, TaskReward, RewardSignal
from src.rl.experience_buffer import ExperienceReplayBuffer, Experience
from src.rl.feedback_collector import FeedbackCollector, UserFeedback
from src.rl.goal_setter import GoalSetter, Goal
from src.rl.knowledge_consolidator import KnowledgeConsolidator
from src.rl.metrics_exporter import MetricsExporter
from src.rl.prompt_evolver import PromptEvolver, PromptVariant
from src.rl.few_shot_selector import FewShotSelector, FewShotExample
from src.rl.router_optimizer import RouterOptimizer, ModelStats
from src.rl.adaptive_context import AdaptiveContextBuilder, ContextSection
from src.rl.benchmark import BenchmarkRunner, BenchmarkScorer, BENCHMARK_TASKS
from src.rl.training_loop import TrainingRunner
from src.rl.mcts_prompt_search import MCTSPromptSearch, PromptConstitution, PromptRule
from src.rl.difficulty_curriculum import (
    DifficultyCurriculum, DifficultyLevel, DifficultyTask,
    StagedRewardCalculator, StabilityMonitor,
)
from src.rl.quality_critic import (
    QualityCritic, MultiEvaluator, CoEvolutionTracker,
)

__all__ = [
    # Foundation
    "RewardModel", "TaskReward", "RewardSignal",
    "ExperienceReplayBuffer", "Experience",
    "FeedbackCollector", "UserFeedback",
    "GoalSetter", "Goal",
    "KnowledgeConsolidator", "MetricsExporter",
    # Adaptive Training
    "PromptEvolver", "PromptVariant",
    "FewShotSelector", "FewShotExample",
    "RouterOptimizer", "ModelStats",
    "AdaptiveContextBuilder", "ContextSection",
    "BenchmarkRunner", "BenchmarkScorer", "BENCHMARK_TASKS",
    "TrainingRunner",
]
