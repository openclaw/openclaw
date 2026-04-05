"""Knowledge Writer — auto-generates Obsidian-style Knowledge entries from learned patterns.

Integrates FeedbackLoopEngine patterns and pipeline results into the
Knowledge/ vault, creating wikilinked Concept and Protocol documents
for the bot's self-learning loop.

Workflow:
1. gap_analysis() — finds topics referenced in code/patterns but missing from Knowledge/
2. generate_concept() — creates a new Concept doc from a pattern or topic
3. update_moc() — adds new entries to MOC.md
4. update_brain_changelog() — logs the knowledge addition in BRAIN.md
"""

from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import structlog

logger = structlog.get_logger("KnowledgeWriter")

_VAULT_ROOT = Path(__file__).resolve().parent.parent.parent
_CONCEPTS_DIR = _VAULT_ROOT / "Knowledge" / "Concepts"
_PROTOCOLS_DIR = _VAULT_ROOT / "Knowledge" / "Protocols"
_MOC_PATH = _VAULT_ROOT / "MOC.md"
_BRAIN_PATH = _VAULT_ROOT / "BRAIN.md"
_SKILLS_PATH = _VAULT_ROOT / "src" / "ai" / "agents" / "special_skills.json"
_LEARNING_LOG_PATH = _VAULT_ROOT / "Learning_Log.md"

_VALID_CATEGORIES = {"domain-knowledge", "code-reference", "troubleshooting"}

# Tags that should have corresponding Knowledge docs
_IMPORTANT_TAGS = {
    "async", "error-handling", "api", "parsing", "caching",
    "testing", "security", "performance", "dmarket", "rust",
    "python", "brigade", "pipeline", "memory", "research",
}


def _existing_concepts() -> Set[str]:
    """Return set of existing concept names (lowercase, without .md)."""
    if not _CONCEPTS_DIR.exists():
        return set()
    return {
        f.stem.lower()
        for f in _CONCEPTS_DIR.iterdir()
        if f.suffix == ".md" and not f.name.startswith(".")
    }


def _existing_protocols() -> Set[str]:
    """Return set of existing protocol names (lowercase, without .md)."""
    if not _PROTOCOLS_DIR.exists():
        return set()
    return {
        f.stem.lower()
        for f in _PROTOCOLS_DIR.iterdir()
        if f.suffix == ".md" and not f.name.startswith(".")
    }


def gap_analysis(patterns_path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Analyze gaps between special_skills.json tags and Knowledge/ vault.

    Returns a list of gap entries:
        [{"topic": "caching", "source": "tag", "reason": "..."}]
    """
    skills_file = Path(patterns_path) if patterns_path else _SKILLS_PATH
    existing = _existing_concepts()
    gaps: List[Dict[str, Any]] = []

    # 1. Check tags in special_skills.json
    if skills_file.exists():
        try:
            data = json.loads(skills_file.read_text(encoding="utf-8"))
            tag_counts: Dict[str, int] = {}
            for pattern in data if isinstance(data, list) else data.get("patterns", []):
                for tag in pattern.get("tags", []):
                    tag_lower = tag.lower().replace("-", "_")
                    tag_counts[tag_lower] = tag_counts.get(tag_lower, 0) + 1

            for tag, count in sorted(tag_counts.items(), key=lambda x: -x[1]):
                if tag in _IMPORTANT_TAGS and tag not in existing:
                    gaps.append({
                        "topic": tag,
                        "source": "special_skills.json",
                        "reason": f"Tag '{tag}' appears in {count} patterns but no Knowledge doc exists",
                        "count": count,
                    })
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Failed to read skills file", error=str(exc))

    # 2. Check for source files mentioned in patterns but not in Knowledge
    src_dir = _VAULT_ROOT / "src"
    if src_dir.exists():
        module_names = set()
        for py_file in src_dir.rglob("*.py"):
            if py_file.name.startswith("_") and py_file.name != "__init__.py":
                continue
            module_names.add(py_file.stem.lower())

        for module in sorted(module_names):
            # Only flag important-sounding modules that are referenced often
            if module in {"supermemory", "feedback_loop", "deep_research", "pipeline"}:
                normalized = module.replace("_", " ").title().replace(" ", "_")
                if normalized.lower() not in existing and module not in existing:
                    gaps.append({
                        "topic": normalized,
                        "source": "src_module",
                        "reason": f"Core module src/.../{module}.py has no Knowledge doc",
                    })

    logger.info("Knowledge gap analysis complete", gaps_found=len(gaps))
    return gaps


def generate_concept(
    topic: str,
    summary: str,
    tags: Optional[List[str]] = None,
    category: str = "domain-knowledge",
    related: Optional[List[str]] = None,
    auto_generated: bool = True,
) -> Optional[Path]:
    """Generate a new Knowledge/Concepts/ document.

    Args:
        topic: Title (used as filename and H1 heading)
        summary: Main content (Markdown body)
        tags: YAML frontmatter tags
        category: One of _VALID_CATEGORIES
        related: List of wikilink targets for the "Связи" section
        auto_generated: Mark as auto-generated in frontmatter

    Returns:
        Path to created file, or None if already exists.
    """
    if category not in _VALID_CATEGORIES:
        category = "domain-knowledge"

    filename = topic.replace(" ", "_").replace("-", "_")
    filepath = _CONCEPTS_DIR / f"{filename}.md"

    if filepath.exists():
        logger.info("Concept already exists, skipping", topic=topic)
        return None

    _CONCEPTS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    tags_list = tags or [topic.lower().replace(" ", "-")]

    # Build wikilinks section
    links_section = ""
    if related:
        links_section = "\n## Связи\n\n" + "\n".join(f"- [[{r}]]" for r in related)

    content = f"""---
tags:
{chr(10).join(f'  - {t}' for t in tags_list)}
category: {category}
difficulty: intermediate
training: true
created: {today}
auto_generated: {str(auto_generated).lower()}
---
# {topic}

{summary.strip()}
{links_section}
"""

    filepath.write_text(content.strip() + "\n", encoding="utf-8")
    logger.info("Knowledge concept generated", path=str(filepath), topic=topic)

    # Log to Learning_Log.md
    _append_learning_log(f"Auto-generated concept: [[{filename}]] — {topic}")

    return filepath


def generate_protocol(
    name: str,
    body: str,
    tags: Optional[List[str]] = None,
) -> Optional[Path]:
    """Generate a new Knowledge/Protocols/ document."""
    filename = name.replace(" ", "_").replace("-", "_")
    filepath = _PROTOCOLS_DIR / f"{filename}.md"

    if filepath.exists():
        logger.info("Protocol already exists, skipping", name=name)
        return None

    _PROTOCOLS_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    tags_list = tags or ["protocol", name.lower().replace(" ", "-")]

    content = f"""---
tags:
{chr(10).join(f'  - {t}' for t in tags_list)}
category: domain-knowledge
difficulty: advanced
training: true
created: {today}
auto_generated: true
---
# Protocol: {name}

{body.strip()}
"""

    filepath.write_text(content.strip() + "\n", encoding="utf-8")
    logger.info("Knowledge protocol generated", path=str(filepath), name=name)
    return filepath


def update_need_knowledge(gaps: List[Dict[str, Any]]) -> None:
    """Update Need_Knowledge.md with current gaps."""
    filepath = _CONCEPTS_DIR / "Need_Knowledge.md"
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    if not gaps:
        content = f"""---
tags:
  - meta
  - todo
category: meta
difficulty: beginner
training: false
created: {today}
---
# Need Knowledge — Gap Analysis
#v16_knowledge

Пробелов в базе знаний не обнаружено. ✅

---
_Обновлено автоматически knowledge_writer.gap_analysis() — {today}_
"""
    else:
        gap_lines = []
        for g in gaps:
            gap_lines.append(f"- **{g['topic']}**: {g['reason']}")

        content = f"""---
tags:
  - meta
  - todo
category: meta
difficulty: beginner
training: false
created: {today}
---
# Need Knowledge — Gap Analysis
#v16_knowledge

Обнаружены пробелы в базе знаний ({len(gaps)}):

{chr(10).join(gap_lines)}

---
_Обновлено автоматически knowledge_writer.gap_analysis() — {today}_
"""

    filepath.write_text(content.strip() + "\n", encoding="utf-8")
    logger.info("Need_Knowledge.md updated", gaps=len(gaps))


def _append_learning_log(entry: str) -> None:
    """Append a timestamped entry to Learning_Log.md."""
    if not _LEARNING_LOG_PATH.exists():
        return
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    line = f"\n- [{timestamp}] {entry}\n"
    with open(_LEARNING_LOG_PATH, "a", encoding="utf-8") as f:
        f.write(line)


def run_self_learning_cycle(patterns_path: Optional[str] = None) -> Dict[str, Any]:
    """Run a complete self-learning cycle:
    1. Gap analysis
    2. Update Need_Knowledge.md
    3. Return report

    Note: Concept generation requires LLM summary — this function
    only identifies gaps. Use generate_concept() with LLM output
    to create actual docs.
    """
    gaps = gap_analysis(patterns_path)
    update_need_knowledge(gaps)

    report = {
        "gaps_found": len(gaps),
        "gaps": gaps,
        "existing_concepts": len(_existing_concepts()),
        "existing_protocols": len(_existing_protocols()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    logger.info(
        "Self-learning cycle complete",
        gaps=len(gaps),
        concepts=report["existing_concepts"],
        protocols=report["existing_protocols"],
    )
    return report
