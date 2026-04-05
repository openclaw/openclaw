"""Tests for Phase 3: research-backed training improvements.

Tests for: MCTSPromptSearch, PromptConstitution, DifficultyCurriculum,
StagedRewardCalculator, StabilityMonitor, QualityCritic,
MultiEvaluator, CoEvolutionTracker.

Research papers validated:
- AFlow (ICLR 2025): MCTS tree search, multi-evaluation
- MAC (arXiv:2603.15968): constitution learning, rule accept/edit/reject
- SAGE (arXiv:2603.15255): difficulty curriculum, quality critic
- Demystifying RL (arXiv:2603.21972): staged rewards, stability monitoring
- Complementary RL (arXiv:2603.17621): co-evolution tracking
"""

import json
import math
import os
import tempfile
import time
from unittest.mock import MagicMock

import pytest

from src.rl.mcts_prompt_search import (
    MCTSNode,
    MCTSPromptSearch,
    PromptConstitution,
    PromptRule,
    CONSTITUTION_MUTATIONS,
    _mutate_add_rule,
    _mutate_edit_rule,
    _mutate_remove_rule,
    _mutate_toggle_rule,
    _mutate_reorder,
)
from src.rl.difficulty_curriculum import (
    DifficultyCurriculum,
    DifficultyLevel,
    DifficultyTask,
    StagedRewardCalculator,
    StabilityMonitor,
    classify_task_difficulty,
    create_difficulty_tasks,
    EASY_TASKS,
    HARD_TASKS,
)
from src.rl.quality_critic import (
    CoEvolutionTracker,
    MultiEvalResult,
    MultiEvaluator,
    QualityCritic,
)
from src.rl.benchmark import BenchmarkCategory, BenchmarkTask


# ===========================================================================
# Helpers
# ===========================================================================

@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        yield d


def _make_constitution() -> PromptConstitution:
    """Create a sample constitution for testing."""
    return PromptConstitution([
        PromptRule("r_id_001", "identity", "Ты — опытный программист.", importance=1.5),
        PromptRule("r_beh_001", "behavior", "1. Пиши чистый, рабочий код."),
        PromptRule("r_beh_002", "behavior", "2. Добавляй docstring и type hints."),
        PromptRule("r_fmt_001", "format", "Используй Markdown для форматирования."),
        PromptRule("r_con_001", "constraint", "НЕ повторяй одну мысль."),
        PromptRule("r_met_001", "meta", "Если не уверен — скажи прямо."),
    ])


# ===========================================================================
# TestPromptRule
# ===========================================================================

class TestPromptRule:
    def test_create(self):
        rule = PromptRule("r1", "behavior", "Пиши чистый код")
        assert rule.rule_id == "r1"
        assert rule.category == "behavior"
        assert rule.active is True
        assert rule.importance == 1.0

    def test_serialization(self):
        rule = PromptRule("r1", "behavior", "Test rule", importance=1.5, active=False)
        d = rule.to_dict()
        restored = PromptRule.from_dict(d)
        assert restored.rule_id == "r1"
        assert restored.importance == 1.5
        assert restored.active is False


# ===========================================================================
# TestPromptConstitution
# ===========================================================================

class TestPromptConstitution:
    def test_create_from_rules(self):
        const = _make_constitution()
        assert len(const) == 6
        assert len(const.get_active_rules()) == 6

    def test_add_rule(self):
        const = _make_constitution()
        const.add_rule(PromptRule("r_new", "behavior", "Новое правило"))
        assert len(const) == 7
        # Adding duplicate does nothing
        const.add_rule(PromptRule("r_new", "behavior", "Другой текст"))
        assert len(const) == 7

    def test_remove_rule(self):
        const = _make_constitution()
        removed = const.remove_rule("r_beh_001")
        assert removed is not None
        assert removed.text == "1. Пиши чистый, рабочий код."
        assert len(const) == 5
        # Removing non-existent returns None
        assert const.remove_rule("nonexistent") is None

    def test_edit_rule(self):
        const = _make_constitution()
        assert const.edit_rule("r_beh_001", "Новый текст")
        # Verify change
        rule = const._rule_index["r_beh_001"]
        assert rule.text == "Новый текст"
        # Editing non-existent returns False
        assert not const.edit_rule("nonexistent", "text")

    def test_toggle_rule(self):
        const = _make_constitution()
        assert const.toggle_rule("r_con_001")
        assert not const._rule_index["r_con_001"].active
        assert len(const.get_active_rules()) == 5
        # Toggle back
        const.toggle_rule("r_con_001")
        assert const._rule_index["r_con_001"].active

    def test_compile_prompt(self):
        const = _make_constitution()
        prompt = const.compile_prompt()
        assert "Ты — опытный программист." in prompt
        assert "НЕ повторяй" in prompt
        assert "Markdown" in prompt
        # Identity should come first (highest importance)
        lines = prompt.split("\n")
        assert "программист" in lines[0]

    def test_compile_prompt_respects_category_order(self):
        const = _make_constitution()
        prompt = const.compile_prompt()
        lines = prompt.split("\n")
        # Identity first, then behavior, format, constraint, meta
        identity_idx = next(i for i, l in enumerate(lines) if "программист" in l)
        meta_idx = next(i for i, l in enumerate(lines) if "не уверен" in l)
        assert identity_idx < meta_idx

    def test_record_reward(self):
        const = _make_constitution()
        const.record_reward(["r_beh_001", "r_fmt_001"], 0.8)
        assert const._rule_index["r_beh_001"].times_tested == 1
        assert const._rule_index["r_beh_001"].avg_reward == 0.8
        const.record_reward(["r_beh_001"], 0.4)
        assert const._rule_index["r_beh_001"].times_tested == 2
        assert abs(const._rule_index["r_beh_001"].avg_reward - 0.6) < 0.01

    def test_get_weak_and_strong_rules(self):
        const = _make_constitution()
        # Record rewards
        const.record_reward(["r_beh_001"], 0.2)
        const.record_reward(["r_beh_001"], 0.1)
        const.record_reward(["r_fmt_001"], 0.9)
        const.record_reward(["r_fmt_001"], 0.8)

        weak = const.get_weak_rules(threshold=0.3, min_tests=2)
        assert any(r.rule_id == "r_beh_001" for r in weak)
        assert not any(r.rule_id == "r_fmt_001" for r in weak)

        strong = const.get_strong_rules(threshold=0.6, min_tests=2)
        assert any(r.rule_id == "r_fmt_001" for r in strong)
        assert not any(r.rule_id == "r_beh_001" for r in strong)

    def test_json_roundtrip(self):
        const = _make_constitution()
        json_str = const.to_json()
        restored = PromptConstitution.from_json(json_str)
        assert len(restored) == len(const)
        assert restored.compile_prompt() == const.compile_prompt()

    def test_from_prompt_text(self):
        text = (
            "Ты — кодер-эксперт.\n"
            "ПРАВИЛА:\n"
            "1. Пиши чистый код.\n"
            "2. Используй type hints.\n"
            "НЕ используй eval().\n"
            "Если не знаешь — скажи честно."
        )
        const = PromptConstitution.from_prompt_text(text, "Executor")
        assert len(const) >= 4
        # First line should be classified as identity
        identity_rules = [r for r in const.rules if r.category == "identity"]
        assert len(identity_rules) >= 1

    def test_clone(self):
        const = _make_constitution()
        clone = const.clone()
        assert len(clone) == len(const)
        # Modify clone shouldn't affect original
        clone.remove_rule("r_beh_001")
        assert len(clone) == 5
        assert len(const) == 6


# ===========================================================================
# TestConstitutionMutations (MAC-inspired)
# ===========================================================================

class TestConstitutionMutations:
    def test_add_rule(self):
        const = _make_constitution()
        original_len = len(const)
        new_const, desc = _mutate_add_rule(const)
        # Original should be unchanged
        assert len(const) == original_len
        # New constitution should have one more rule
        assert len(new_const) == original_len + 1
        assert "add_rule" in desc

    def test_edit_rule(self):
        const = _make_constitution()
        new_const, desc = _mutate_edit_rule(const)
        assert "edit" in desc
        # Some rule text should differ
        original_texts = {r.text for r in const.rules}
        new_texts = {r.text for r in new_const.rules}
        # At least one text should be different (or noop)
        assert original_texts != new_texts or "noop" in desc

    def test_remove_rule(self):
        const = _make_constitution()
        new_const, desc = _mutate_remove_rule(const)
        assert "remove" in desc
        # Should have one fewer rule (or noop if only identity rules)
        assert len(new_const) <= len(const)

    def test_toggle_rule(self):
        const = _make_constitution()
        new_const, desc = _mutate_toggle_rule(const)
        assert "toggle" in desc

    def test_reorder(self):
        const = _make_constitution()
        new_const, desc = _mutate_reorder(const)
        assert "reorder" in desc

    def test_all_mutations_preserve_original(self):
        """All mutations should return new constitution without modifying original."""
        for name, fn in CONSTITUTION_MUTATIONS.items():
            const = _make_constitution()
            original_json = const.to_json()
            new_const, desc = fn(const)
            assert const.to_json() == original_json, f"Mutation {name} modified original"


# ===========================================================================
# TestMCTSNode
# ===========================================================================

class TestMCTSNode:
    def test_ucb1_unvisited(self):
        node = MCTSNode("n1", "Executor", "code", _make_constitution())
        assert node.ucb1_score(10) == float("inf")

    def test_ucb1_visited(self):
        node = MCTSNode("n1", "Executor", "code", _make_constitution())
        node.record_evaluation(0.7)
        node.record_evaluation(0.8)
        score = node.ucb1_score(100)
        # Expected: 0.75 + 1.414 * sqrt(ln(100)/2) ≈ 0.75 + 1.414 * 1.517 ≈ 2.89
        assert 2.0 < score < 4.0

    def test_record_evaluation(self):
        node = MCTSNode("n1", "Executor", "code", _make_constitution())
        node.record_evaluation(0.6)
        node.record_evaluation(0.8)
        node.record_evaluation(1.0)
        assert node.visit_count == 3
        assert abs(node.mean_reward - 0.8) < 0.01
        assert node.best_reward == 1.0
        assert node.reward_variance > 0

    def test_prompt_text(self):
        node = MCTSNode("n1", "Executor", "code", _make_constitution())
        assert "программист" in node.prompt_text

    def test_prompt_hash(self):
        node = MCTSNode("n1", "Executor", "code", _make_constitution())
        assert len(node.prompt_hash) == 12


# ===========================================================================
# TestMCTSPromptSearch
# ===========================================================================

class TestMCTSPromptSearch:
    def test_create_root(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.")
        assert root.node_id == "mcts_root_Executor_code"
        assert root.depth == 0
        assert "кодер" in root.prompt_text

    def test_select_unvisited_first(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.")
        # No children, should return root
        leaf = search.select(root)
        assert leaf.node_id == root.node_id

    def test_expand(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.\n1. Пиши чисто.\n2. Тесты.")
        child = search.expand(root)
        assert child.depth == 1
        assert child.parent_id == root.node_id
        assert len(root.children) == 1

    def test_backpropagate(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.")
        child = search.expand(root)
        search.backpropagate(child, 0.85)
        # Both child and root should have the reward
        assert child.visit_count == 1
        assert abs(child.mean_reward - 0.85) < 0.01
        assert root.visit_count == 1
        assert abs(root.mean_reward - 0.85) < 0.01

    def test_best_node(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.")
        c1 = search.expand(root)
        c2 = search.expand(root)
        search.backpropagate(c1, 0.3)
        search.backpropagate(c1, 0.4)
        search.backpropagate(c2, 0.9)
        search.backpropagate(c2, 0.8)
        best = search.best_node(root)
        assert best.node_id == c2.node_id

    def test_tree_stats(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.")
        search.expand(root)
        search.expand(root)
        stats = search.tree_stats(root)
        assert stats["total_nodes"] == 3
        assert stats["max_depth"] == 1

    def test_ucb1_selects_unvisited_child(self, tmp_dir):
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.")
        c1 = search.expand(root)
        c2 = search.expand(root)
        # Visit c1 only
        search.backpropagate(c1, 0.5)
        root.visit_count = 1  # set parent visits
        # UCB1 should prefer unvisited c2
        leaf = search.select(root)
        assert leaf.node_id == c2.node_id  # unvisited has inf UCB1

    def test_persist_and_load(self, tmp_dir):
        db_path = os.path.join(tmp_dir, "mcts.db")
        search = MCTSPromptSearch(db_path)
        search.initialize()
        root = search.create_root("Executor", "code", "Ты — кодер.\n1. Тест.")
        child = search.expand(root)
        search.backpropagate(child, 0.7)
        search.close()

        # Load from fresh instance
        search2 = MCTSPromptSearch(db_path)
        search2.initialize()
        loaded_root = search2.load_tree("Executor", "code")
        assert loaded_root is not None
        assert loaded_root.visit_count == 1
        search2.close()


# ===========================================================================
# TestDifficultyClassification
# ===========================================================================

class TestDifficultyClassification:
    def test_easy_task(self):
        task = BenchmarkTask(
            task_id="test_easy",
            category=BenchmarkCategory.CONVERSATION,
            prompt="Привет!",
            min_length=10,
            max_length=200,
        )
        level, score = classify_task_difficulty(task)
        assert level == DifficultyLevel.EASY
        assert score < 0.3

    def test_hard_task(self):
        task = BenchmarkTask(
            task_id="test_hard",
            category=BenchmarkCategory.CODE,
            prompt="Напиши функцию\n```python\ndef parse(expr):\n    pass\n```\nРеализуй рекурсивный спуск.",
            required_keywords=["def parse", "return", "token"],
            expects_code=True,
            min_length=300,
        )
        level, score = classify_task_difficulty(task)
        assert level == DifficultyLevel.HARD
        assert score > 0.6

    def test_create_difficulty_tasks(self):
        tasks = create_difficulty_tasks()
        assert len(tasks) > 0
        # Should have mix of difficulties
        levels = {t.difficulty for t in tasks}
        assert len(levels) >= 2  # at least 2 different levels

    def test_easy_tasks_exist(self):
        assert len(EASY_TASKS) >= 3

    def test_hard_tasks_exist(self):
        assert len(HARD_TASKS) >= 5
        for task in HARD_TASKS:
            assert task.difficulty == DifficultyLevel.HARD


# ===========================================================================
# TestStagedRewardCalculator
# ===========================================================================

class TestStagedRewardCalculator:
    def test_easy_binary(self):
        calc = StagedRewardCalculator(model_capability=0.5)
        task = DifficultyTask(
            task_id="t1", category=BenchmarkCategory.CONVERSATION,
            prompt="Hi", difficulty=DifficultyLevel.EASY,
        )
        # High score → 1.0
        assert calc.compute_staged_reward(task, 0.8, {}) == 1.0
        # Low score → 0.0
        assert calc.compute_staged_reward(task, 0.3, {}) == 0.0

    def test_medium_partial_credit(self):
        calc = StagedRewardCalculator(model_capability=0.5)
        task = DifficultyTask(
            task_id="t1", category=BenchmarkCategory.CODE,
            prompt="Code", difficulty=DifficultyLevel.MEDIUM,
        )
        # Below floor → 0.0
        assert calc.compute_staged_reward(task, 0.2, {}) == 0.0
        # Above ceiling → ~1.0
        r = calc.compute_staged_reward(task, 0.95, {})
        assert r > 0.9
        # In between → partial credit
        r = calc.compute_staged_reward(task, 0.6, {})
        assert 0.2 < r < 0.8

    def test_hard_fine_grained(self):
        calc = StagedRewardCalculator(model_capability=0.5)
        task = DifficultyTask(
            task_id="t1", category=BenchmarkCategory.CODE,
            prompt="Complex task", expects_code=True,
            difficulty=DifficultyLevel.HARD,
        )
        breakdown = {
            "keyword_score": 0.8,
            "length_score": 0.9,
            "code_format_score": 0.7,
            "language_score": 1.0,
            "forbidden_score": 1.0,
        }
        r = calc.compute_staged_reward(task, 0.8, breakdown)
        # Should give partial credit from components
        assert 0.4 < r < 1.0

    def test_hard_zero_components(self):
        calc = StagedRewardCalculator(model_capability=0.5)
        task = DifficultyTask(
            task_id="t1", category=BenchmarkCategory.CODE,
            prompt="Complex", expects_code=True,
            difficulty=DifficultyLevel.HARD,
        )
        r = calc.compute_staged_reward(task, 0.0, {})
        assert r < 0.4


# ===========================================================================
# TestDifficultyCurriculum
# ===========================================================================

class TestDifficultyCurriculum:
    def test_initial_stage(self):
        curriculum = DifficultyCurriculum()
        assert curriculum._current_stage_idx == 0
        assert curriculum.stage_name == "Разогрев"

    def test_sample_batch(self):
        curriculum = DifficultyCurriculum()
        batch = curriculum.sample_batch(8)
        assert len(batch) <= 8
        assert len(batch) > 0
        # Should have difficulty-task instances
        for task in batch:
            assert isinstance(task, DifficultyTask)

    def test_stage_advancement(self):
        curriculum = DifficultyCurriculum()
        # Record consistently high scores
        for _ in range(5):
            curriculum.record_batch_result(0.8)
        # Should have advanced from stage 0
        assert curriculum._current_stage_idx >= 1

    def test_no_advancement_on_low_scores(self):
        curriculum = DifficultyCurriculum()
        for _ in range(5):
            curriculum.record_batch_result(0.2)
        assert curriculum._current_stage_idx == 0

    def test_auto_advance_on_max_iterations(self):
        curriculum = DifficultyCurriculum()
        # Record many mediocre scores — should auto-advance after max_iterations
        for _ in range(25):
            curriculum.record_batch_result(0.4)
        assert curriculum._current_stage_idx >= 1

    def test_difficulty_mix_changes_per_stage(self):
        curriculum = DifficultyCurriculum()
        mix_0 = curriculum.current_stage.difficulty_mix.copy()
        # Force advance
        for _ in range(25):
            curriculum.record_batch_result(0.9)
        mix_1 = curriculum.current_stage.difficulty_mix
        # Difficulty mix should change
        assert mix_0[DifficultyLevel.EASY] > mix_1.get(DifficultyLevel.EASY, 0)

    def test_get_stats(self):
        curriculum = DifficultyCurriculum()
        stats = curriculum.get_stats()
        assert "current_stage" in stats
        assert "stage_name" in stats
        assert "difficulty_mix" in stats
        assert "task_pool_sizes" in stats


# ===========================================================================
# TestStabilityMonitor
# ===========================================================================

class TestStabilityMonitor:
    def test_stable_training(self):
        monitor = StabilityMonitor()
        for score in [0.5, 0.52, 0.54, 0.55, 0.57]:
            alert = monitor.record(score)
        assert alert is None
        assert monitor.is_stable()

    def test_collapse_detection(self):
        monitor = StabilityMonitor(collapse_threshold=0.15)
        for score in [0.7, 0.72, 0.71, 0.73]:
            monitor.record(score)
        # Sudden drop
        alert = monitor.record(0.3)
        assert alert is not None
        assert alert["type"] == "collapse"
        assert alert["severity"] == "high"

    def test_oscillation_detection(self):
        monitor = StabilityMonitor(oscillation_threshold=0.03, collapse_threshold=1.0)
        # High variance scores — collapse disabled so oscillation can trigger
        scores = [0.5, 0.51, 0.52, 0.3, 0.9, 0.2, 0.8, 0.3]
        alerts = [monitor.record(s) for s in scores]
        # At least one oscillation alert should fire
        osc_alerts = [a for a in alerts if a and a["type"] == "oscillation"]
        assert len(osc_alerts) >= 1

    def test_plateau_detection(self):
        monitor = StabilityMonitor(
            plateau_window=5, plateau_min_improvement=0.02,
        )
        # Flat scores
        for _ in range(6):
            monitor.record(0.50)
        alert = monitor.record(0.50)
        # Should detect plateau
        assert alert is not None
        assert alert["type"] == "plateau"

    def test_recommendation_rollback(self):
        monitor = StabilityMonitor(collapse_threshold=0.1)
        for s in [0.7, 0.72, 0.71]:
            monitor.record(s)
        monitor.record(0.3)
        assert monitor.get_recommendation() == "rollback"

    def test_recommendation_stable(self):
        monitor = StabilityMonitor()
        assert monitor.get_recommendation() == "stable"

    def test_get_stats(self):
        monitor = StabilityMonitor()
        monitor.record(0.5)
        stats = monitor.get_stats()
        assert "total_records" in stats
        assert "is_stable" in stats
        assert "recommendation" in stats


# ===========================================================================
# TestMultiEvaluator
# ===========================================================================

class TestMultiEvaluator:
    def test_record_and_needs_more(self):
        evaluator = MultiEvaluator(n_evaluations=3)
        evaluator.record("v1", 0.7)
        assert evaluator.needs_more_evals("v1")
        evaluator.record("v1", 0.8)
        assert evaluator.needs_more_evals("v1")
        evaluator.record("v1", 0.75)
        assert not evaluator.needs_more_evals("v1")

    def test_mean_score(self):
        evaluator = MultiEvaluator(n_evaluations=3)
        evaluator.record("v1", 0.6)
        evaluator.record("v1", 0.8)
        evaluator.record("v1", 1.0)
        result = evaluator.get_result("v1")
        assert result is not None
        assert abs(result.mean_score - 0.8) < 0.01

    def test_std_score(self):
        evaluator = MultiEvaluator(n_evaluations=3)
        evaluator.record("v1", 0.5)
        evaluator.record("v1", 0.5)
        evaluator.record("v1", 0.5)
        result = evaluator.get_result("v1")
        assert result is not None
        assert result.std_score == 0.0

    def test_confidence(self):
        evaluator = MultiEvaluator(n_evaluations=5)
        evaluator.record("v1", 0.7)
        c1 = evaluator.get_result("v1").confidence
        evaluator.record("v1", 0.7)
        evaluator.record("v1", 0.7)
        c3 = evaluator.get_result("v1").confidence
        # More evals = higher confidence (with 0 std, std_factor=1.0 always,
        # but n_factor grows: 1/5=0.2 vs 3/5=0.6)
        assert c3 > c1

    def test_reliable_results(self):
        evaluator = MultiEvaluator(n_evaluations=3)
        evaluator.record("v1", 0.8)
        evaluator.record("v1", 0.8)
        evaluator.record("v1", 0.8)
        evaluator.record("v2", 0.5)  # only 1 eval
        reliable = evaluator.get_reliable_results(min_confidence=0.5)
        assert len(reliable) >= 1

    def test_get_nonexistent(self):
        evaluator = MultiEvaluator(n_evaluations=3)
        assert evaluator.get_result("nonexistent") is None
        assert evaluator.needs_more_evals("nonexistent")


# ===========================================================================
# TestMultiEvalResult
# ===========================================================================

class TestMultiEvalResult:
    def test_empty(self):
        r = MultiEvalResult("v1")
        assert r.n_evals == 0
        assert r.mean_score == 0.0
        assert r.std_score == 0.0
        assert r.confidence == 0.0

    def test_min_max(self):
        r = MultiEvalResult("v1")
        r.add(0.3)
        r.add(0.9)
        r.add(0.6)
        assert r.min_score == 0.3
        assert r.max_score == 0.9


# ===========================================================================
# TestQualityCritic
# ===========================================================================

class TestQualityCritic:
    def test_accept_good_variant(self):
        critic = QualityCritic(min_absolute_score=0.25)
        candidate = MultiEvalResult("v1")
        candidate.add(0.7)
        candidate.add(0.8)
        accepted, reason = critic.evaluate(candidate, None, "Ты — кодер. Пиши чисто.")
        assert accepted
        assert "Принято" in reason

    def test_reject_low_score(self):
        critic = QualityCritic(min_absolute_score=0.3)
        candidate = MultiEvalResult("v1")
        candidate.add(0.1)
        candidate.add(0.2)
        accepted, reason = critic.evaluate(candidate, None, "Some prompt text here")
        assert not accepted
        assert "below_min_score" in reason or "score" in reason

    def test_reject_no_improvement(self):
        critic = QualityCritic(improvement_threshold=-0.05, min_prompt_length=10)
        parent = MultiEvalResult("parent")
        parent.add(0.8)
        parent.add(0.85)
        candidate = MultiEvalResult("child")
        candidate.add(0.5)
        candidate.add(0.55)
        accepted, reason = critic.evaluate(
            candidate, parent,
            "Это достаточно длинный промпт для прохождения проверки длины",
        )
        assert not accepted
        assert "улучшения" in reason or "improvement" in reason

    def test_reject_too_short_prompt(self):
        critic = QualityCritic(min_prompt_length=20)
        candidate = MultiEvalResult("v1")
        candidate.add(0.9)
        accepted, reason = critic.evaluate(candidate, None, "Hi")
        assert not accepted
        assert "коротк" in reason

    def test_reject_too_long_prompt(self):
        critic = QualityCritic(max_prompt_length=50)
        candidate = MultiEvalResult("v1")
        candidate.add(0.9)
        accepted, reason = critic.evaluate(candidate, None, "x" * 100)
        assert not accepted
        assert "длинн" in reason

    def test_reject_high_variance(self):
        critic = QualityCritic(max_variance_threshold=0.1)
        candidate = MultiEvalResult("v1")
        candidate.add(0.2)
        candidate.add(0.9)
        candidate.add(0.1)
        accepted, reason = critic.evaluate(candidate, None, "Normal length prompt text here")
        assert not accepted
        assert "вариативность" in reason or "variance" in reason

    def test_acceptance_rate(self):
        critic = QualityCritic()
        # One accepted
        good = MultiEvalResult("v1")
        good.add(0.8)
        critic.evaluate(good, None, "Good prompt text for testing purposes")
        # One rejected
        bad = MultiEvalResult("v2")
        bad.add(0.05)
        critic.evaluate(bad, None, "Bad prompt text for testing purposes here")
        assert critic.get_acceptance_rate() == 0.5

    def test_rejection_reasons(self):
        critic = QualityCritic(min_absolute_score=0.5)
        bad = MultiEvalResult("v1")
        bad.add(0.1)
        critic.evaluate(bad, None, "Some text here for evaluation")
        reasons = critic.get_rejection_reasons()
        assert "below_min_score" in reasons

    def test_get_stats(self):
        critic = QualityCritic()
        stats = critic.get_stats()
        assert "total_evaluated" in stats
        assert "acceptance_rate" in stats
        assert "rejection_reasons" in stats


# ===========================================================================
# TestCoEvolutionTracker
# ===========================================================================

class TestCoEvolutionTracker:
    def test_record_and_lookup(self, tmp_dir):
        tracker = CoEvolutionTracker(os.path.join(tmp_dir, "coevo.db"))
        tracker.initialize()
        tracker.record("pv_1", ["fs_a", "fs_b"], "code", 0.8, baseline_score=0.5)
        tracker.record("pv_1", ["fs_c"], "code", 0.6, baseline_score=0.5)

        best = tracker.get_best_few_shots_for_prompt("pv_1", "code")
        assert len(best) >= 1
        # Best combo should be the one with higher score
        assert best[0][1] >= 0.6

    def test_synergy_score(self, tmp_dir):
        tracker = CoEvolutionTracker(os.path.join(tmp_dir, "coevo.db"))
        tracker.initialize()
        tracker.record("pv_1", ["fs_a", "fs_b"], "code", 0.9, baseline_score=0.5)
        synergy = tracker.get_synergy_score("pv_1", ["fs_a", "fs_b"])
        assert synergy > 0  # positive synergy

    def test_stats(self, tmp_dir):
        tracker = CoEvolutionTracker(os.path.join(tmp_dir, "coevo.db"))
        tracker.initialize()
        tracker.record("pv_1", ["fs_a"], "code", 0.8, baseline_score=0.5)
        tracker.record("pv_2", ["fs_b"], "code", 0.3, baseline_score=0.5)
        stats = tracker.get_stats()
        assert stats["total_records"] == 2
        assert stats["positive_synergies"] == 1
        assert stats["negative_synergies"] == 1
        tracker.close()

    def test_empty_stats(self, tmp_dir):
        tracker = CoEvolutionTracker(os.path.join(tmp_dir, "coevo.db"))
        tracker.initialize()
        stats = tracker.get_stats()
        assert stats["total_records"] == 0
        assert stats["synergy_rate"] == 0.0
        tracker.close()


# ===========================================================================
# TestIntegration — full MCTS search cycle
# ===========================================================================

class TestMCTSIntegration:
    def test_full_search_cycle(self, tmp_dir):
        """Test complete MCTS: create → select → expand → evaluate → backprop."""
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()

        root = search.create_root(
            "Executor", "code",
            "Ты — кодер.\n1. Пиши чисто.\n2. Тесты.\nНЕ копипасти."
        )

        # Run 10 iterations
        for _ in range(10):
            leaf = search.select(root)
            child = search.expand(leaf)
            # Simulate evaluation (random score)
            import random
            score = random.uniform(0.3, 0.9)
            search.backpropagate(child, score)

        stats = search.tree_stats(root)
        assert stats["total_nodes"] >= 11  # root + 10 children
        assert stats["total_visits"] >= 10

        best = search.best_node(root)
        assert best.visit_count >= 1
        assert best.mean_reward > 0

        search.close()

    def test_curriculum_with_mcts(self, tmp_dir):
        """Integration: curriculum samples tasks, MCTS optimizes prompts."""
        curriculum = DifficultyCurriculum()
        search = MCTSPromptSearch(os.path.join(tmp_dir, "mcts.db"))
        search.initialize()

        root = search.create_root("Executor", "code", "Ты — кодер.")
        stability = StabilityMonitor()
        critic = QualityCritic()
        evaluator = MultiEvaluator(n_evaluations=2)

        # Simulate 3 rounds
        for _ in range(3):
            batch = curriculum.sample_batch(4)
            assert len(batch) > 0

            leaf = search.select(root)
            child = search.expand(leaf)

            # Simulate multi-eval
            import random
            for _ in range(2):
                score = random.uniform(0.4, 0.8)
                evaluator.record(child.node_id, score)

            result = evaluator.get_result(child.node_id)
            accepted, _ = critic.evaluate(result, None, child.prompt_text)

            if accepted:
                search.backpropagate(child, result.mean_score)

            stability.record(result.mean_score)

        assert stability.is_stable()
        search.close()

    def test_difficulty_distribution_per_stage(self):
        """Verify curriculum produces correct difficulty distribution."""
        curriculum = DifficultyCurriculum()

        # Stage 0: mostly easy
        batch = curriculum.sample_batch(20)
        easy_count = sum(1 for t in batch if t.difficulty == DifficultyLevel.EASY)
        # With 70% easy, expect majority easy
        assert easy_count >= 5

        # Advance to harder stage
        for _ in range(25):
            curriculum.record_batch_result(0.8)

        # Should have advanced
        assert curriculum._current_stage_idx >= 1

    def test_staged_rewards_by_difficulty(self):
        """Verify staged rewards differ by difficulty level."""
        calc = StagedRewardCalculator(model_capability=0.5)

        score = 0.6
        breakdown = {"keyword_score": 0.6, "length_score": 0.7}

        easy_task = DifficultyTask(
            task_id="e", category=BenchmarkCategory.CONVERSATION,
            prompt="Hi", difficulty=DifficultyLevel.EASY,
        )
        med_task = DifficultyTask(
            task_id="m", category=BenchmarkCategory.CODE,
            prompt="Code", difficulty=DifficultyLevel.MEDIUM,
        )
        hard_task = DifficultyTask(
            task_id="h", category=BenchmarkCategory.CODE,
            prompt="Hard", expects_code=True,
            difficulty=DifficultyLevel.HARD,
        )

        easy_r = calc.compute_staged_reward(easy_task, score, breakdown)
        med_r = calc.compute_staged_reward(med_task, score, breakdown)
        hard_r = calc.compute_staged_reward(hard_task, score, breakdown)

        # Easy: binary (should be 1.0 since 0.6 > 0.5)
        assert easy_r == 1.0
        # Medium and hard: partial credit (different values)
        assert 0.0 < med_r < 1.0 or med_r > 0
        assert hard_r > 0
