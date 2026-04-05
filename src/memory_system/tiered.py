"""
Brigade: OpenClaw
Role: Enhanced Memory System (MemGPT + Mem-α + Memento)

Research-backed memory improvements:
- TieredMemoryManager: hot/warm/cold tiers (MemGPT, arXiv:2310.08560)
- MemoryImportanceScorer: RL-inspired importance scoring (Mem-α)
- EpisodicMemory: TF-IDF episode retrieval (Memento, arXiv:2508.16153)

Zero VRAM overhead — all operations are CPU/disk.
Compatible with existing memory_gc.py system.
"""

from __future__ import annotations

import json
import math
import os
import re
import time
from dataclasses import asdict, dataclass, field
from typing import Dict, List, Optional

import structlog

logger = structlog.get_logger(__name__)


from src.utils.token_counter import estimate_tokens as _estimate_tokens


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class MemoryItem:
    """A single memory record that can live in any tier."""

    key: str
    content: str
    tier: str = "hot"  # "hot" | "warm" | "cold"
    importance: float = 0.5
    created_at: float = field(default_factory=time.time)
    last_access: float = field(default_factory=time.time)
    access_count: int = 0
    source: str = "conversation"  # "conversation" | "tool" | "archive" | "episode"

    def touch(self) -> None:
        self.last_access = time.time()
        self.access_count += 1

    def token_count(self) -> int:
        return _estimate_tokens(self.content)

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict) -> "MemoryItem":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class EpisodeRecord:
    """A completed episode trajectory for few-shot retrieval."""

    episode_id: str
    task: str
    steps: List[Dict[str, str]]
    reward: float
    success: bool
    timestamp: float = field(default_factory=time.time)
    compressed_summary: str = ""

    def to_dict(self) -> Dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Dict) -> "EpisodeRecord":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class MemoryStats:
    """Aggregate statistics across all memory tiers."""

    items_per_tier: Dict[str, int] = field(default_factory=dict)
    total_tokens: int = 0
    oldest_item: Optional[str] = None
    most_accessed: Optional[str] = None


# ---------------------------------------------------------------------------
# WorkingMemoryPage (MemGPT page management)
# ---------------------------------------------------------------------------

class WorkingMemoryPage:
    """A page of working memory that can be paged in/out.

    Each page has:
    - content: the actual text
    - importance: computed by MemoryImportanceScorer
    - last_access: timestamp of last read
    - access_count: number of reads
    - source: where this came from (conversation, tool, archive)
    """

    __slots__ = ("key", "content", "importance", "last_access", "access_count", "source")

    def __init__(
        self,
        key: str,
        content: str,
        importance: float = 0.5,
        source: str = "conversation",
    ):
        self.key = key
        self.content = content
        self.importance = importance
        self.last_access = time.time()
        self.access_count = 0
        self.source = source

    def read(self) -> str:
        """Return content and mark as accessed."""
        self.last_access = time.time()
        self.access_count += 1
        return self.content

    def token_count(self) -> int:
        return _estimate_tokens(self.content)

    def to_memory_item(self, tier: str = "hot") -> MemoryItem:
        return MemoryItem(
            key=self.key,
            content=self.content,
            tier=tier,
            importance=self.importance,
            last_access=self.last_access,
            access_count=self.access_count,
            source=self.source,
        )


# ---------------------------------------------------------------------------
# Simple TF-IDF (stdlib only, no numpy/sklearn)
# ---------------------------------------------------------------------------

_STOP_WORDS = frozenset(
    "a an the is are was were be been being have has had do does did will "
    "would shall should may might can could and but or nor for yet so at by "
    "to in on of from with as it its this that these those i you he she we "
    "they me him her us them my your his our their".split()
)

_WORD_RE = re.compile(r"[a-zA-Z0-9а-яА-ЯёЁ_]+")  # English + Russian tokens


def _tokenize(text: str) -> List[str]:
    return [w.lower() for w in _WORD_RE.findall(text) if w.lower() not in _STOP_WORDS]


def _build_tfidf_vector(tokens: List[str], idf: Dict[str, float]) -> Dict[str, float]:
    """Term-frequency * inverse-document-frequency vector."""
    tf: Dict[str, float] = {}
    for t in tokens:
        tf[t] = tf.get(t, 0.0) + 1.0
    if not tf:
        return {}
    max_tf = max(tf.values())
    return {t: (0.5 + 0.5 * freq / max_tf) * idf.get(t, 1.0) for t, freq in tf.items()}


def _cosine_similarity(a: Dict[str, float], b: Dict[str, float]) -> float:
    """Cosine similarity between two sparse vectors."""
    if not a or not b:
        return 0.0
    keys = set(a) & set(b)
    if not keys:
        return 0.0
    dot = sum(a[k] * b[k] for k in keys)
    norm_a = math.sqrt(sum(v * v for v in a.values()))
    norm_b = math.sqrt(sum(v * v for v in b.values()))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ---------------------------------------------------------------------------
# MemoryImportanceScorer (Mem-α: RL-driven importance)
# ---------------------------------------------------------------------------

class MemoryImportanceScorer:
    """Score memory items by importance using RL-inspired signals.

    From Mem-α: Learning Memory Construction via RL.
    Instead of static rules, uses multiple signals to score importance:
    - Recency: how recent is the memory?
    - Frequency: how often was it accessed?
    - Relevance: keyword overlap with current context
    - Reward correlation: did using this memory lead to higher rewards?
    """

    # Signal weights (tunable)
    W_RECENCY = 0.25
    W_FREQUENCY = 0.20
    W_RELEVANCE = 0.30
    W_REWARD = 0.25

    # Recency half-life in seconds (6 hours)
    RECENCY_HALF_LIFE = 6 * 3600.0

    def __init__(self) -> None:
        # Per-key cumulative reward tracker: key -> (total_reward, use_count)
        self._reward_history: Dict[str, tuple[float, int]] = {}

    def score(self, item: MemoryItem, current_context: str = "") -> float:
        """Compute importance score [0.0, 1.0] for a memory item."""
        recency = self._recency_score(item)
        frequency = self._frequency_score(item)
        relevance = self._relevance_score(item, current_context)
        reward = self._reward_score(item.key)

        raw = (
            self.W_RECENCY * recency
            + self.W_FREQUENCY * frequency
            + self.W_RELEVANCE * relevance
            + self.W_REWARD * reward
        )
        return max(0.0, min(1.0, raw))

    def update_after_use(self, item_key: str, reward: float) -> None:
        """Update importance model after memory was used (RL signal)."""
        total, count = self._reward_history.get(item_key, (0.0, 0))
        self._reward_history[item_key] = (total + reward, count + 1)
        logger.debug("memory_reward_update", key=item_key, reward=reward, uses=count + 1)

    def decay_all(self, factor: float = 0.95) -> None:
        """Apply time decay to all memory importance scores.

        Multiplicatively decays cumulative rewards, simulating forgetting.
        """
        for key in list(self._reward_history):
            total, count = self._reward_history[key]
            self._reward_history[key] = (total * factor, count)
        logger.debug("memory_decay_applied", factor=factor, keys=len(self._reward_history))

    # -- Internal scoring functions --

    def _recency_score(self, item: MemoryItem) -> float:
        """Exponential decay based on time since last access."""
        age = time.time() - item.last_access
        return math.exp(-0.693 * age / self.RECENCY_HALF_LIFE)  # 0.693 = ln(2)

    def _frequency_score(self, item: MemoryItem) -> float:
        """Log-scaled frequency; diminishing returns after many accesses."""
        if item.access_count <= 0:
            return 0.0
        return min(1.0, math.log1p(item.access_count) / math.log1p(20))

    def _relevance_score(self, item: MemoryItem, context: str) -> float:
        """Keyword overlap between item content and current context."""
        if not context:
            return 0.0
        item_words = set(_tokenize(item.content))
        ctx_words = set(_tokenize(context))
        if not item_words or not ctx_words:
            return 0.0
        overlap = len(item_words & ctx_words)
        return min(1.0, overlap / max(1, min(len(item_words), len(ctx_words))))

    def _reward_score(self, key: str) -> float:
        """Average reward when this memory was used."""
        entry = self._reward_history.get(key)
        if not entry or entry[1] == 0:
            return 0.5  # neutral prior
        avg = entry[0] / entry[1]
        return max(0.0, min(1.0, avg))


# ---------------------------------------------------------------------------
# TieredMemoryManager (MemGPT: arXiv:2310.08560)
# ---------------------------------------------------------------------------

class TieredMemoryManager:
    """Three-tier memory system inspired by MemGPT (OS-like memory management).

    Tiers:
    - Hot (working memory): Current conversation context, most recent facts
    - Warm (session memory): Important facts from recent conversations
    - Cold (archival memory): Long-term knowledge, .memory-bank files

    Automatic page-in/page-out based on relevance scoring.
    Zero VRAM overhead — all operations are CPU/disk.
    """

    def __init__(
        self,
        memory_bank_dir: str = ".memory-bank",
        max_hot_tokens: int = 2000,
        max_warm_items: int = 100,
    ):
        self.memory_bank_dir = memory_bank_dir
        self.max_hot_tokens = max_hot_tokens
        self.max_warm_items = max_warm_items

        self._hot: Dict[str, MemoryItem] = {}
        self._warm: Dict[str, MemoryItem] = {}
        self._cold: Dict[str, MemoryItem] = {}

        self._scorer = MemoryImportanceScorer()

        # Bootstrap cold tier from .memory-bank files
        self._load_cold_from_disk()
        logger.info(
            "tiered_memory_init",
            cold_items=len(self._cold),
            max_hot_tokens=max_hot_tokens,
            max_warm_items=max_warm_items,
        )

    # -- Public API --

    def add_to_hot(self, key: str, content: str, importance: float = 0.5) -> None:
        """Add item to hot (working) memory."""
        item = MemoryItem(key=key, content=content, tier="hot", importance=importance)
        self._hot[key] = item
        logger.debug("memory_add_hot", key=key, tokens=item.token_count())

        # Trigger page-out if over budget
        if self._hot_token_count() > self.max_hot_tokens:
            self.page_out()

    def promote_to_warm(self, key: str) -> None:
        """Move item from cold to warm when it becomes relevant."""
        item = self._cold.pop(key, None)
        if item is None:
            logger.warning("promote_not_found", key=key, source="cold")
            return
        item.tier = "warm"
        item.touch()
        self._warm[key] = item

        # Evict oldest warm items if over capacity
        while len(self._warm) > self.max_warm_items:
            self._evict_least_important_warm()

        logger.debug("memory_promote_warm", key=key)

    def page_out(self) -> List[str]:
        """Move least-important hot items to warm tier until under budget."""
        paged_keys: List[str] = []
        while self._hot_token_count() > self.max_hot_tokens and self._hot:
            worst_key = min(self._hot, key=lambda k: self._hot[k].importance)
            item = self._hot.pop(worst_key)
            item.tier = "warm"
            self._warm[worst_key] = item
            paged_keys.append(worst_key)

        if paged_keys:
            logger.info("memory_page_out", keys=paged_keys, remaining_hot=len(self._hot))

        # Cascade: evict warm overflow to cold
        while len(self._warm) > self.max_warm_items:
            self._evict_least_important_warm()

        return paged_keys

    def page_in(self, query: str, k: int = 3) -> List[MemoryItem]:
        """Retrieve relevant items from warm/cold tiers into hot."""
        candidates: List[MemoryItem] = []
        for item in list(self._warm.values()) + list(self._cold.values()):
            score = self._scorer.score(item, current_context=query)
            item.importance = score
            candidates.append(item)

        candidates.sort(key=lambda it: it.importance, reverse=True)
        paged: List[MemoryItem] = []

        for item in candidates[:k]:
            # Move to hot
            self._warm.pop(item.key, None)
            self._cold.pop(item.key, None)
            item.tier = "hot"
            item.touch()
            self._hot[item.key] = item
            paged.append(item)

        if paged:
            logger.info(
                "memory_page_in",
                keys=[it.key for it in paged],
                scores=[round(it.importance, 3) for it in paged],
            )

        # Re-balance hot tier
        if self._hot_token_count() > self.max_hot_tokens:
            self.page_out()

        return paged

    def get_context_window(self, max_tokens: int = 2000) -> str:
        """Get formatted context from hot memory for LLM prompt."""
        items = sorted(self._hot.values(), key=lambda it: it.importance, reverse=True)
        parts: List[str] = []
        budget = max_tokens

        for item in items:
            item_tokens = item.token_count()
            if item_tokens > budget:
                continue
            parts.append(f"[{item.key}] {item.content}")
            budget -= item_tokens
            item.touch()

        return "\n".join(parts)

    def get_stats(self) -> MemoryStats:
        """Gather statistics across all tiers."""
        all_items = list(self._hot.values()) + list(self._warm.values()) + list(self._cold.values())

        oldest = min(all_items, key=lambda it: it.created_at).key if all_items else None
        most_acc = max(all_items, key=lambda it: it.access_count).key if all_items else None

        return MemoryStats(
            items_per_tier={
                "hot": len(self._hot),
                "warm": len(self._warm),
                "cold": len(self._cold),
            },
            total_tokens=sum(it.token_count() for it in all_items),
            oldest_item=oldest,
            most_accessed=most_acc,
        )

    def rescore_hot(self, current_context: str = "") -> None:
        """Rescore all hot items against current context (call after context shift)."""
        for item in self._hot.values():
            item.importance = self._scorer.score(item, current_context)

    def update_reward(self, key: str, reward: float) -> None:
        """Feed RL reward signal for a memory key."""
        self._scorer.update_after_use(key, reward)

    def decay(self, factor: float = 0.95) -> None:
        """Apply global time-decay to importance scores."""
        self._scorer.decay_all(factor)

    # -- Internal helpers --

    def _hot_token_count(self) -> int:
        return sum(it.token_count() for it in self._hot.values())

    def _evict_least_important_warm(self) -> None:
        if not self._warm:
            return
        worst_key = min(self._warm, key=lambda k: self._warm[k].importance)
        item = self._warm.pop(worst_key)
        item.tier = "cold"
        self._cold[worst_key] = item

    def _load_cold_from_disk(self) -> None:
        """Bootstrap cold tier from .memory-bank markdown files."""
        if not os.path.isdir(self.memory_bank_dir):
            logger.debug("memory_bank_dir_missing", dir=self.memory_bank_dir)
            return

        for root, _dirs, files in os.walk(self.memory_bank_dir):
            for fname in files:
                if not fname.endswith(".md"):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        content = f.read()
                except OSError:
                    continue

                rel = os.path.relpath(fpath, self.memory_bank_dir)
                key = f"bank:{rel}"
                self._cold[key] = MemoryItem(
                    key=key,
                    content=content,
                    tier="cold",
                    importance=0.3,
                    source="archive",
                )

    # -- Persistence (save/restore with version field) --

    _STATE_VERSION = 1

    def save_state(self, path: str) -> None:
        """Persist hot + warm tiers to JSON with version field."""
        state = {
            "version": self._STATE_VERSION,
            "hot": {k: v.to_dict() for k, v in self._hot.items()},
            "warm": {k: v.to_dict() for k, v in self._warm.items()},
        }
        from pathlib import Path as _P
        p = _P(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("TieredMemory state saved", path=path, hot=len(self._hot), warm=len(self._warm))

    def restore_state(self, path: str) -> None:
        """Load hot + warm tiers from JSON; ignores unknown keys."""
        from pathlib import Path as _P
        p = _P(path)
        if not p.exists():
            return
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            version = data.get("version", 0)
            if version > self._STATE_VERSION:
                logger.warning("State file version newer than supported", file_version=version)
            for k, d in data.get("hot", {}).items():
                self._hot[k] = MemoryItem.from_dict(d)
            for k, d in data.get("warm", {}).items():
                self._warm[k] = MemoryItem.from_dict(d)
            logger.info("TieredMemory state restored", path=path, hot=len(self._hot), warm=len(self._warm))
        except Exception as e:
            logger.warning("Failed to restore TieredMemory state", error=str(e))


# ---------------------------------------------------------------------------
# EpisodicMemory (Memento: arXiv:2508.16153)
# ---------------------------------------------------------------------------

class EpisodicMemory:
    """Enhanced episodic memory with similarity-based retrieval.

    From Memento (arXiv:2508.16153): Fine-tuning agents without fine-tuning LLMs.
    Stores successful episode trajectories and retrieves similar ones
    to provide few-shot examples for current tasks.

    Extends the existing episode memory in memory_gc.py with:
    - TF-IDF-based similarity (no external deps)
    - Configurable retention policies
    - Episode compression for long-term storage
    """

    def __init__(self, storage_dir: str = "training_data"):
        self.storage_dir = storage_dir
        self._episodes: List[EpisodeRecord] = []
        self._storage_file = os.path.join(storage_dir, "enhanced_episodes.jsonl")
        self._idf_dirty = True
        self._idf_cache: Dict[str, float] = {}
        self._load()

    # -- Public API --

    def store_episode(self, episode: EpisodeRecord) -> None:
        """Store a completed episode with its trajectory."""
        self._episodes.append(episode)
        self._idf_dirty = True
        self._persist_one(episode)
        logger.info(
            "episode_stored",
            episode_id=episode.episode_id,
            reward=episode.reward,
            steps=len(episode.steps),
        )

    def retrieve_similar(self, query: str, k: int = 3) -> List[EpisodeRecord]:
        """Find similar past episodes using TF-IDF similarity."""
        if not self._episodes:
            return []

        self._rebuild_idf_if_needed()

        query_tokens = _tokenize(query)
        query_vec = _build_tfidf_vector(query_tokens, self._idf_cache)

        scored: List[tuple[float, EpisodeRecord]] = []
        for ep in self._episodes:
            ep_tokens = _tokenize(ep.task)
            ep_vec = _build_tfidf_vector(ep_tokens, self._idf_cache)
            sim = _cosine_similarity(query_vec, ep_vec)
            scored.append((sim, ep))

        scored.sort(key=lambda x: (-x[0], -x[1].reward))
        return [ep for sim_score, ep in scored[:k] if sim_score > 0.0]

    def compress_old_episodes(self, max_age_days: int = 30) -> int:
        """Compress old episodes to save disk space.

        Replaces full step trajectories with a compressed summary
        for episodes older than max_age_days.

        Returns:
            Number of episodes compressed.
        """
        cutoff = time.time() - (max_age_days * 86400)
        compressed_count = 0

        for ep in self._episodes:
            if ep.timestamp >= cutoff:
                continue
            if ep.compressed_summary:
                continue  # already compressed

            # Build a terse summary from the trajectory
            step_texts = []
            for step in ep.steps[:10]:
                role = step.get("role", "?")
                content = step.get("content", "")[:120]
                step_texts.append(f"{role}: {content}")
            ep.compressed_summary = (
                f"Task: {ep.task[:200]}\nReward: {ep.reward}\n"
                + "\n".join(step_texts)
            )
            ep.steps = []  # free the detailed trajectory
            compressed_count += 1

        if compressed_count:
            self._rewrite_all()
            logger.info("episodes_compressed", count=compressed_count, cutoff_days=max_age_days)

        return compressed_count

    def get_few_shot_examples(self, task: str, k: int = 2) -> str:
        """Get formatted few-shot examples from similar past episodes."""
        similar = self.retrieve_similar(task, k=k)
        if not similar:
            return ""

        parts: List[str] = []
        for i, ep in enumerate(similar, 1):
            header = f"--- Example {i} (reward={ep.reward:.2f}) ---"
            if ep.compressed_summary:
                body = ep.compressed_summary
            else:
                step_lines = []
                for step in ep.steps[:6]:
                    role = step.get("role", "?")
                    content = step.get("content", "")[:200]
                    step_lines.append(f"  {role}: {content}")
                body = f"Task: {ep.task}\n" + "\n".join(step_lines)
            parts.append(f"{header}\n{body}")

        return "\n\n".join(parts)

    def import_from_memory_gc(self, episodes: List[Dict]) -> int:
        """Import episodes from the legacy memory_gc.py format.

        Converts the dict-based episodes from MemoryGarbageCollector
        into EpisodeRecord objects.

        Returns:
            Number of episodes imported.
        """
        imported = 0
        for raw in episodes:
            task = raw.get("task", "")
            if not task:
                continue
            record = EpisodeRecord(
                episode_id=f"legacy-{raw.get('timestamp', str(time.time()))}",
                task=task,
                steps=raw.get("trajectory", []),
                reward=raw.get("reward", 0.0),
                success=raw.get("reward", 0.0) >= 0.6,
                timestamp=_parse_iso_ts(raw.get("timestamp", "")),
            )
            self._episodes.append(record)
            imported += 1

        if imported:
            self._idf_dirty = True
            self._rewrite_all()
            logger.info("episodes_imported_from_legacy", count=imported)

        return imported

    # -- Internal --

    def _load(self) -> None:
        if not os.path.exists(self._storage_file):
            return
        try:
            with open(self._storage_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        self._episodes.append(EpisodeRecord.from_dict(json.loads(line)))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("episode_load_error", error=str(exc))

    def _persist_one(self, episode: EpisodeRecord) -> None:
        os.makedirs(self.storage_dir, exist_ok=True)
        with open(self._storage_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(episode.to_dict(), ensure_ascii=False) + "\n")

    def _rewrite_all(self) -> None:
        """Rewrite the full JSONL file (used after compression/import)."""
        os.makedirs(self.storage_dir, exist_ok=True)
        with open(self._storage_file, "w", encoding="utf-8") as f:
            for ep in self._episodes:
                f.write(json.dumps(ep.to_dict(), ensure_ascii=False) + "\n")

    def _rebuild_idf_if_needed(self) -> None:
        if not self._idf_dirty:
            return
        doc_freq: Dict[str, int] = {}
        n = len(self._episodes)
        for ep in self._episodes:
            unique_tokens = set(_tokenize(ep.task))
            for t in unique_tokens:
                doc_freq[t] = doc_freq.get(t, 0) + 1
        self._idf_cache = {
            t: math.log((n + 1) / (df + 1)) + 1 for t, df in doc_freq.items()
        }
        self._idf_dirty = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _parse_iso_ts(iso_str: str) -> float:
    """Best-effort ISO-8601 to epoch; falls back to current time."""
    if not iso_str:
        return time.time()
    try:
        from datetime import datetime, timezone

        # Handle both Z and +00:00 suffixes
        cleaned = iso_str.replace("Z", "+00:00")
        dt = datetime.fromisoformat(cleaned)
        return dt.timestamp()
    except (ValueError, TypeError):
        return time.time()
