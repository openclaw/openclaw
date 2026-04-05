"""MCTS Prompt Search — tree-structured prompt optimization.

Inspired by:
- AFlow (ICLR 2025): MCTS-based workflow generation with exploration/exploitation
- MAC (arXiv:2603.15968): Multi-Agent Constitution Learning with structured rules

Instead of flat random mutations, this module maintains a SEARCH TREE of
prompt variants. Each node is a prompt state with children being mutated
descendants. Selection uses UCB1 (Upper Confidence Bound) to balance
exploitation of best-known prompts with exploration of less-tested variants.

Key innovations over flat PromptEvolver:
1. Tree structure: mutations build on successful ancestors (no random parent)
2. UCB1 selection: principled exploration/exploitation balance
3. Constitution representation: prompts as structured RULE SETS
4. Multi-evaluation: each variant scored N times for robustness
5. Backpropagation: rewards propagate up the tree to ancestors

References:
- AFlow: Automating Agentic Workflow Generation (ICLR 2025)
- MAC: Multi-Agent Constitution Learning (arXiv:2603.15968)
- Kocsis & Szepesvári (2006): UCB applied to trees
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import random
import sqlite3
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger("MCTSPromptSearch")

# UCB1 exploration constant (higher = more exploration)
_UCB_C = 1.414


# ---------------------------------------------------------------------------
# Constitution: structured rule-based prompt representation (MAC-inspired)
# ---------------------------------------------------------------------------

@dataclass
class PromptRule:
    """A single rule in a constitution-style prompt."""
    rule_id: str
    category: str  # identity, format, constraint, behavior, meta
    text: str
    importance: float = 1.0  # 0.0-2.0, affects prompt ordering
    active: bool = True
    times_tested: int = 0
    avg_reward: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rule_id": self.rule_id,
            "category": self.category,
            "text": self.text,
            "importance": self.importance,
            "active": self.active,
            "times_tested": self.times_tested,
            "avg_reward": self.avg_reward,
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "PromptRule":
        return cls(**d)


class PromptConstitution:
    """Structured prompt as a set of rules (MAC-inspired).

    Instead of treating prompts as opaque text, represents them as a set of
    typed rules that can be individually accepted, edited, or rejected.
    This enables much finer-grained optimization than string mutations.
    """

    def __init__(self, rules: Optional[List[PromptRule]] = None) -> None:
        self.rules = rules or []
        self._rule_index: Dict[str, PromptRule] = {r.rule_id: r for r in self.rules}

    def add_rule(self, rule: PromptRule) -> None:
        if rule.rule_id not in self._rule_index:
            self.rules.append(rule)
            self._rule_index[rule.rule_id] = rule

    def remove_rule(self, rule_id: str) -> Optional[PromptRule]:
        if rule_id in self._rule_index:
            rule = self._rule_index.pop(rule_id)
            self.rules = [r for r in self.rules if r.rule_id != rule_id]
            return rule
        return None

    def edit_rule(self, rule_id: str, new_text: str) -> bool:
        if rule_id in self._rule_index:
            self._rule_index[rule_id].text = new_text
            return True
        return False

    def toggle_rule(self, rule_id: str) -> bool:
        if rule_id in self._rule_index:
            self._rule_index[rule_id].active = not self._rule_index[rule_id].active
            return True
        return False

    def get_active_rules(self) -> List[PromptRule]:
        """Get all active rules sorted by importance (highest first)."""
        return sorted(
            [r for r in self.rules if r.active],
            key=lambda r: -r.importance,
        )

    def compile_prompt(self) -> str:
        """Compile active rules into a single prompt string."""
        active = self.get_active_rules()
        if not active:
            return ""

        parts: List[str] = []
        # Group by category
        categories = {}
        for rule in active:
            categories.setdefault(rule.category, []).append(rule)

        # Render in order: identity → behavior → format → constraint → meta
        order = ["identity", "behavior", "format", "constraint", "meta"]
        for cat in order:
            if cat in categories:
                for rule in categories[cat]:
                    parts.append(rule.text)
                del categories[cat]
        # Any remaining categories
        for cat_rules in categories.values():
            for rule in cat_rules:
                parts.append(rule.text)

        return "\n".join(parts)

    def record_reward(self, rule_ids: List[str], reward: float) -> None:
        """Record reward feedback for specific rules (MAC accept/reject)."""
        for rid in rule_ids:
            if rid in self._rule_index:
                rule = self._rule_index[rid]
                rule.times_tested += 1
                # Incremental mean update
                rule.avg_reward += (reward - rule.avg_reward) / rule.times_tested

    def get_weak_rules(self, threshold: float = 0.3, min_tests: int = 2) -> List[PromptRule]:
        """Find rules with consistently low rewards (candidates for editing/rejection)."""
        return [
            r for r in self.rules
            if r.active and r.times_tested >= min_tests and r.avg_reward < threshold
        ]

    def get_strong_rules(self, threshold: float = 0.6, min_tests: int = 2) -> List[PromptRule]:
        """Find rules with consistently high rewards."""
        return [
            r for r in self.rules
            if r.active and r.times_tested >= min_tests and r.avg_reward >= threshold
        ]

    def to_json(self) -> str:
        return json.dumps([r.to_dict() for r in self.rules], ensure_ascii=False)

    @classmethod
    def from_json(cls, data: str) -> "PromptConstitution":
        rules = [PromptRule.from_dict(d) for d in json.loads(data)]
        return cls(rules)

    @classmethod
    def from_prompt_text(cls, text: str, role: str = "Executor") -> "PromptConstitution":
        """Parse a plain-text prompt into constitution rules."""
        rules: List[PromptRule] = []
        lines = text.strip().split("\n")

        for i, line in enumerate(lines):
            line = line.strip()
            if not line:
                continue

            # Classify rule category
            if i == 0 or "Ты —" in line or "ты —" in line:
                category = "identity"
            elif line.startswith("ПРАВИЛА") or line.startswith("RULES"):
                continue  # skip section headers
            elif "НЕ " in line or "ЗАПРЕЩ" in line or "не " in line and "не уверен" not in line.lower():
                category = "constraint"
            elif line.startswith(tuple(f"{n}." for n in range(1, 10))):
                category = "behavior"
            elif "формат" in line.lower() or "markdown" in line.lower() or "структур" in line.lower():
                category = "format"
            else:
                category = "behavior"

            rule_id = f"r_{role}_{i:03d}"
            rules.append(PromptRule(
                rule_id=rule_id,
                category=category,
                text=line,
                importance=1.5 if category == "identity" else 1.0,
            ))

        return cls(rules)

    def clone(self) -> "PromptConstitution":
        """Deep clone the constitution."""
        return PromptConstitution.from_json(self.to_json())

    def __len__(self) -> int:
        return len(self.rules)


# ---------------------------------------------------------------------------
# MCTS Node
# ---------------------------------------------------------------------------

@dataclass
class MCTSNode:
    """A node in the MCTS search tree for prompt optimization."""
    node_id: str
    role: str
    task_type: str
    constitution: PromptConstitution
    parent_id: str = ""
    mutation_type: str = "root"  # root, add_rule, edit_rule, remove_rule, toggle_rule, reorder
    depth: int = 0

    # MCTS statistics
    visit_count: int = 0
    total_reward: float = 0.0
    mean_reward: float = 0.0
    best_reward: float = 0.0
    reward_variance: float = 0.0
    _reward_sq_sum: float = 0.0

    children: List["MCTSNode"] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)

    @property
    def prompt_text(self) -> str:
        return self.constitution.compile_prompt()

    @property
    def prompt_hash(self) -> str:
        return hashlib.sha256(self.prompt_text.encode()).hexdigest()[:12]

    def ucb1_score(self, parent_visits: int) -> float:
        """UCB1 score: exploitation + exploration bonus."""
        if self.visit_count == 0:
            return float("inf")  # always explore unvisited nodes
        exploitation = self.mean_reward
        exploration = _UCB_C * math.sqrt(math.log(parent_visits) / self.visit_count)
        return exploitation + exploration

    def record_evaluation(self, reward: float) -> None:
        """Record a single evaluation result (multi-eval robustness)."""
        self.visit_count += 1
        self.total_reward += reward
        self._reward_sq_sum += reward * reward
        self.mean_reward = self.total_reward / self.visit_count
        self.best_reward = max(self.best_reward, reward)
        if self.visit_count > 1:
            self.reward_variance = (
                self._reward_sq_sum / self.visit_count - self.mean_reward ** 2
            )


# ---------------------------------------------------------------------------
# Constitution Mutations (MAC-inspired: accept / edit / reject)
# ---------------------------------------------------------------------------

# New rule templates that can be added during expansion
_RULE_TEMPLATES = {
    "behavior": [
        "Начинай ответ с ключевого вывода.",
        "Разбивай сложные задачи на логические шаги.",
        "Приводи конкретные примеры после каждого утверждения.",
        "Используй аналогии для объяснения сложных концепций.",
        "Если есть несколько подходов — кратко сравни их.",
    ],
    "format": [
        "Используй Markdown для структурирования ответа.",
        "Для списков > 3 элементов используй нумерацию.",
        "Код оборачивай в ```язык блоки.",
        "Таблицы используй для сравнения 2+ объектов.",
    ],
    "constraint": [
        "НЕ повторяй одну мысль разными словами.",
        "НЕ начинай ответ с \"Конечно\" или \"Разумеется\".",
        "МАКСИМУМ 3 предложения на один пункт.",
        "НЕ используй вводные фразы типа 'Как известно'.",
    ],
    "meta": [
        "Если не уверен — скажи прямо, не выдумывай.",
        "Если вопрос неоднозначен — уточни перед ответом.",
        "Калибруй длину ответа по сложности вопроса.",
    ],
}


def _mutate_add_rule(constitution: PromptConstitution) -> Tuple[PromptConstitution, str]:
    """MAC: propose a NEW rule from templates."""
    new_const = constitution.clone()
    category = random.choice(list(_RULE_TEMPLATES.keys()))
    templates = _RULE_TEMPLATES[category]

    # Avoid duplicates
    existing_texts = {r.text for r in new_const.rules}
    candidates = [t for t in templates if t not in existing_texts]
    if not candidates:
        candidates = templates

    text = random.choice(candidates)
    rule_id = f"r_gen_{int(time.time() * 1000) % 100000:05d}"
    new_const.add_rule(PromptRule(
        rule_id=rule_id,
        category=category,
        text=text,
    ))
    return new_const, f"add_rule:{category}"


def _mutate_edit_rule(constitution: PromptConstitution) -> Tuple[PromptConstitution, str]:
    """MAC: edit an existing rule (rephrase/strengthen)."""
    new_const = constitution.clone()
    active = new_const.get_active_rules()
    if not active:
        return new_const, "edit_noop"

    rule = random.choice(active)
    edits = [
        lambda t: "**" + t + "**",  # emphasis
        lambda t: t.replace(".", ". Это критически важно.") if "критически" not in t else t,
        lambda t: t + " Без исключений." if "исключений" not in t else t,
        lambda t: "ОБЯЗАТЕЛЬНО: " + t if "ОБЯЗАТЕЛЬНО" not in t else t,
    ]
    edit_fn = random.choice(edits)
    new_const.edit_rule(rule.rule_id, edit_fn(rule.text))
    return new_const, f"edit_rule:{rule.rule_id}"


def _mutate_remove_rule(constitution: PromptConstitution) -> Tuple[PromptConstitution, str]:
    """MAC: reject (remove) a rule — especially weak ones."""
    new_const = constitution.clone()

    # Prefer removing weak rules
    weak = new_const.get_weak_rules(threshold=0.4, min_tests=1)
    if weak:
        rule = random.choice(weak)
    else:
        # Don't remove identity rules
        removable = [r for r in new_const.rules if r.category != "identity"]
        if not removable:
            return new_const, "remove_noop"
        rule = random.choice(removable)

    new_const.remove_rule(rule.rule_id)
    return new_const, f"remove_rule:{rule.rule_id}"


def _mutate_toggle_rule(constitution: PromptConstitution) -> Tuple[PromptConstitution, str]:
    """MAC: temporarily deactivate/reactivate a rule."""
    new_const = constitution.clone()
    if not new_const.rules:
        return new_const, "toggle_noop"
    rule = random.choice(new_const.rules)
    new_const.toggle_rule(rule.rule_id)
    return new_const, f"toggle:{rule.rule_id}"


def _mutate_reorder(constitution: PromptConstitution) -> Tuple[PromptConstitution, str]:
    """Change importance of random rules to affect ordering."""
    new_const = constitution.clone()
    active = new_const.get_active_rules()
    if len(active) < 2:
        return new_const, "reorder_noop"

    rule = random.choice(active)
    delta = random.choice([-0.3, -0.2, 0.2, 0.3])
    rule.importance = max(0.1, min(2.0, rule.importance + delta))
    return new_const, f"reorder:{rule.rule_id}"


CONSTITUTION_MUTATIONS = {
    "add_rule": _mutate_add_rule,
    "edit_rule": _mutate_edit_rule,
    "remove_rule": _mutate_remove_rule,
    "toggle_rule": _mutate_toggle_rule,
    "reorder": _mutate_reorder,
}


# ---------------------------------------------------------------------------
# MCTS Prompt Search Engine
# ---------------------------------------------------------------------------

class MCTSPromptSearch:
    """Tree-structured prompt optimization using MCTS.

    Usage:
        search = MCTSPromptSearch("data/rl/mcts_search.db")
        search.initialize()

        # Create root from existing prompt
        root = search.create_root("Executor", "code", existing_prompt_text)

        # Run N iterations of MCTS (selection → expansion → evaluation → backprop)
        for _ in range(20):
            leaf = search.select(root)
            child = search.expand(leaf)
            # ... evaluate child.prompt_text via LLM ...
            search.backpropagate(child, reward=0.75)

        # Get best prompt found
        best = search.best_node(root)
    """

    def __init__(self, db_path: str = "data/rl/mcts_search.db") -> None:
        self._db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None
        self._nodes: Dict[str, MCTSNode] = {}

    def initialize(self) -> None:
        os.makedirs(os.path.dirname(self._db_path) or ".", exist_ok=True)
        self._conn = sqlite3.connect(self._db_path)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS mcts_nodes (
                node_id TEXT PRIMARY KEY,
                role TEXT NOT NULL,
                task_type TEXT NOT NULL,
                constitution_json TEXT NOT NULL,
                parent_id TEXT DEFAULT '',
                mutation_type TEXT DEFAULT 'root',
                depth INTEGER DEFAULT 0,
                visit_count INTEGER DEFAULT 0,
                total_reward REAL DEFAULT 0.0,
                mean_reward REAL DEFAULT 0.0,
                best_reward REAL DEFAULT 0.0,
                reward_sq_sum REAL DEFAULT 0.0,
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_mcts_role_task
                ON mcts_nodes(role, task_type);
            CREATE INDEX IF NOT EXISTS idx_mcts_parent
                ON mcts_nodes(parent_id);
        """)
        self._conn.commit()

    def _ensure_init(self) -> None:
        if self._conn is None:
            self.initialize()

    # ------------------------------------------------------------------
    # Tree construction
    # ------------------------------------------------------------------

    def create_root(
        self, role: str, task_type: str, prompt_text: str,
    ) -> MCTSNode:
        """Create root node from existing prompt text."""
        self._ensure_init()

        constitution = PromptConstitution.from_prompt_text(prompt_text, role)
        node_id = f"mcts_root_{role}_{task_type}"

        node = MCTSNode(
            node_id=node_id,
            role=role,
            task_type=task_type,
            constitution=constitution,
            mutation_type="root",
        )
        self._nodes[node_id] = node
        self._persist_node(node)
        return node

    def select(self, root: MCTSNode) -> MCTSNode:
        """MCTS Selection: traverse tree using UCB1 to find a leaf.

        Uses UCB1 (AFlow-inspired) probability:
        P(i) = exploration_weight * (1 - s_i/s_max) / n + exploit_weight * f(s_i)

        Simplified here to standard UCB1 for clarity.
        """
        current = root
        while current.children:
            # Pick child with highest UCB1 score
            parent_visits = max(current.visit_count, 1)
            best_child = max(current.children, key=lambda c: c.ucb1_score(parent_visits))
            current = best_child
        return current

    def expand(self, node: MCTSNode, max_children: int = 3) -> MCTSNode:
        """MCTS Expansion: create a child node via constitution mutation.

        Applies MAC-style mutations: add, edit, remove, toggle, reorder rules.
        """
        self._ensure_init()

        # Pick mutation (weighted: prefer add/edit over remove)
        weights = {"add_rule": 0.3, "edit_rule": 0.3, "remove_rule": 0.15,
                    "toggle_rule": 0.1, "reorder": 0.15}
        mutation_name = random.choices(
            list(weights.keys()),
            weights=list(weights.values()),
            k=1,
        )[0]
        mutation_fn = CONSTITUTION_MUTATIONS[mutation_name]

        new_constitution, mutation_desc = mutation_fn(node.constitution)

        # Create child node
        child_id = f"mcts_{node.role}_{node.task_type}_{int(time.time()*1000)%1000000}"
        child = MCTSNode(
            node_id=child_id,
            role=node.role,
            task_type=node.task_type,
            constitution=new_constitution,
            parent_id=node.node_id,
            mutation_type=mutation_desc,
            depth=node.depth + 1,
        )

        node.children.append(child)
        self._nodes[child_id] = child
        self._persist_node(child)
        return child

    def backpropagate(self, node: MCTSNode, reward: float) -> None:
        """MCTS Backpropagation: propagate reward up to root.

        Also updates per-rule rewards in the constitution (MAC feedback).
        """
        # Update per-rule rewards in the constitution
        active_rule_ids = [r.rule_id for r in node.constitution.get_active_rules()]
        node.constitution.record_reward(active_rule_ids, reward)

        # Propagate up the tree
        current: Optional[MCTSNode] = node
        while current is not None:
            current.record_evaluation(reward)
            self._persist_node(current)
            current = self._nodes.get(current.parent_id)

    def best_node(self, root: MCTSNode) -> MCTSNode:
        """Get the best node (highest mean reward with sufficient visits)."""
        all_nodes = self._collect_nodes(root)
        # Require at least 2 visits (multi-evaluation robustness from AFlow)
        evaluated = [n for n in all_nodes if n.visit_count >= 2]
        if not evaluated:
            evaluated = [n for n in all_nodes if n.visit_count >= 1]
        if not evaluated:
            return root
        return max(evaluated, key=lambda n: n.mean_reward)

    def get_top_nodes(self, root: MCTSNode, n: int = 5) -> List[MCTSNode]:
        """Get top-N nodes by mean reward."""
        all_nodes = self._collect_nodes(root)
        evaluated = [nd for nd in all_nodes if nd.visit_count >= 1]
        evaluated.sort(key=lambda nd: -nd.mean_reward)
        return evaluated[:n]

    def tree_stats(self, root: MCTSNode) -> Dict[str, Any]:
        """Statistics about the search tree."""
        all_nodes = self._collect_nodes(root)
        evaluated = [n for n in all_nodes if n.visit_count > 0]
        return {
            "total_nodes": len(all_nodes),
            "evaluated_nodes": len(evaluated),
            "max_depth": max((n.depth for n in all_nodes), default=0),
            "best_reward": max((n.best_reward for n in all_nodes), default=0.0),
            "mean_reward": (
                sum(n.mean_reward for n in evaluated) / len(evaluated)
                if evaluated else 0.0
            ),
            "total_visits": sum(n.visit_count for n in all_nodes),
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _collect_nodes(self, root: MCTSNode) -> List[MCTSNode]:
        """DFS to collect all nodes in subtree."""
        result = [root]
        stack = list(root.children)
        while stack:
            node = stack.pop()
            result.append(node)
            stack.extend(node.children)
        return result

    def _persist_node(self, node: MCTSNode) -> None:
        """Persist node to SQLite."""
        if not self._conn:
            return
        self._conn.execute("""
            INSERT OR REPLACE INTO mcts_nodes
            (node_id, role, task_type, constitution_json, parent_id,
             mutation_type, depth, visit_count, total_reward, mean_reward,
             best_reward, reward_sq_sum, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            node.node_id, node.role, node.task_type,
            node.constitution.to_json(), node.parent_id,
            node.mutation_type, node.depth,
            node.visit_count, node.total_reward, node.mean_reward,
            node.best_reward, node._reward_sq_sum, node.created_at,
        ))
        self._conn.commit()

    def load_tree(self, role: str, task_type: str) -> Optional[MCTSNode]:
        """Load a previously persisted search tree from DB."""
        self._ensure_init()
        assert self._conn is not None

        rows = self._conn.execute(
            "SELECT * FROM mcts_nodes WHERE role = ? AND task_type = ? ORDER BY depth ASC",
            (role, task_type),
        ).fetchall()
        if not rows:
            return None

        for row in rows:
            node = MCTSNode(
                node_id=row[0],
                role=row[1],
                task_type=row[2],
                constitution=PromptConstitution.from_json(row[3]),
                parent_id=row[4],
                mutation_type=row[5],
                depth=row[6],
                visit_count=row[7],
                total_reward=row[8],
                mean_reward=row[9],
                best_reward=row[10],
                _reward_sq_sum=row[11],
            )
            node.created_at = row[12]
            self._nodes[node.node_id] = node

        # Reconstruct parent-child links
        for node in self._nodes.values():
            if node.parent_id and node.parent_id in self._nodes:
                parent = self._nodes[node.parent_id]
                if node not in parent.children:
                    parent.children.append(node)

        root_id = f"mcts_root_{role}_{task_type}"
        return self._nodes.get(root_id)

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
