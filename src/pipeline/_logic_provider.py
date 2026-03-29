"""
Obsidian Logic Integration for OpenClaw v16.0
Reads configuration, logic overrides, and dynamic instructions from .obsidian vault.
Records learning logs directly back into Obsidian for Self-Teaching.
"""

import os
import re
import structlog
from typing import Optional, List, Tuple

try:
    import json
except ImportError:
    import json

logger = structlog.get_logger("LogicProvider")

_project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OBSIDIAN_DIR = os.path.join(_project_root, ".obsidian")
CLAW_LOGIC_DIR = os.path.join(OBSIDIAN_DIR, "claw_logic")
LEARNING_LOG_PATH = os.path.join(OBSIDIAN_DIR, "Learning_Log.md")

VAULT_MAP = {
    "Concepts": os.path.join(OBSIDIAN_DIR, "Knowledge", "Concepts"),
    "Snippets": os.path.join(OBSIDIAN_DIR, "Knowledge", "Snippets"),
    "Protocols": os.path.join(OBSIDIAN_DIR, "Knowledge", "Protocols"),
    "Logic": CLAW_LOGIC_DIR,
    "Learning_Log": LEARNING_LOG_PATH,
}

def _ensure_dirs():
    os.makedirs(CLAW_LOGIC_DIR, exist_ok=True)
    for path in VAULT_MAP.values():
        if not path.endswith(".md"):
            os.makedirs(path, exist_ok=True)

def get_brigade_logic(brigade_name: str) -> str:
    """Read brigade's custom logic from .obsidian/claw_logic/<brigade_name>.md."""
    _ensure_dirs()
    path = os.path.join(CLAW_LOGIC_DIR, f"{brigade_name}.md")
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if content:
                logger.info("Loaded custom brigade logic from Obsidian", brigade=brigade_name)
                return f"\n\n[OBSIDIAN BRIGADE LOGIC ({brigade_name})]\n{content}\n"
        except Exception as e:
            logger.warning("Failed to read Obsidian brigade logic", error=str(e), brigade=brigade_name)
    return ""

def record_learning(task: str, error: str, fix: str):
    """Append a learning entry to Learning_Log.md as a Markdown table row."""
    _ensure_dirs()
    try:
        # One line markdown strip
        task_clean = task.replace('\n', ' ').replace('|', '\\|')[:200]
        error_clean = error.replace('\n', ' ').replace('|', '\\|')[:500] if error else "Success"
        fix_clean = fix.replace('\n', ' ').replace('|', '\\|')[:500]
        tag = "[Logic]"
        check_text = f"{error_clean} {task_clean}".lower()
        # v16.2 Fast Classifier: Regex/Keyword patterns
        _API_PATTERNS = re.compile(
            r"404|500|401|429|endpoint|timeout|connectionerror|dmarket\s*api|http\s*error|network\s*error|api",
            re.IGNORECASE,
        )
        _SYNTAX_PATTERNS = re.compile(
            r"syntaxerror|indentationerror|invalid\s+syntax|expected|nameerror|typeerror|importerror|indent",
            re.IGNORECASE,
        )
        if _API_PATTERNS.search(check_text):
            tag = "[API]"
        elif _SYNTAX_PATTERNS.search(check_text):
            tag = "[Syntax]"
            
        if error_clean != "Success":
            error_clean = f"{tag} {error_clean}"
        elif tag != "[Logic]":
            error_clean = f"{tag} Fixed in execution"
        
        row = f"| {task_clean} | {error_clean} | {fix_clean} |\n"
        
        # Write header if file doesn't exist or is empty
        is_new = not os.path.exists(LEARNING_LOG_PATH) or os.path.getsize(LEARNING_LOG_PATH) == 0
        
        with open(LEARNING_LOG_PATH, "a", encoding="utf-8") as f:
            if is_new:
                f.write("| Task | Error | Fix / Insight |\n")
                f.write("|---|---|---|\n")
            f.write(row)
            
        if tag == "[API]" and error_clean != "Success":
            api_fixes_path = os.path.join(VAULT_MAP["Concepts"], "API_Fixes.md")
            with open(api_fixes_path, "a", encoding="utf-8") as f:
                f.write(f"\n## API Fix: {task_clean}\n- **Error**: {error_clean}\n- **Fix**: {fix_clean}\n")
            
        logger.info("Recorded learning log to Obsidian", task=task_clean, tag=tag)
    except Exception as e:
        logger.error("Failed to append to Learning_Log.md", error=str(e))

# v16.4: Error detection patterns for MCP tool results
_ERROR_PREFIXES = ("⏳", "🔒", "🛡️", "📁", "❌", "Error:")


def is_tool_error(result: str) -> bool:
    """v16.4: Detect if a tool call result is an error response."""
    if not result:
        return False
    stripped = result.strip()
    return any(stripped.startswith(p) for p in _ERROR_PREFIXES)


async def autonomous_reflection(
    task: str,
    code: str,
    stderr: str,
    inference_fn=None,
) -> str:
    """v16.4: Autonomous Self-Healing Reflection Engine.

    Analyses an error via LLM and records the fix rule to Obsidian Learning_Log.
    Returns the fix rule text or empty string on failure.

    Args:
        task: Original user task description.
        code: Code/context that caused the error.
        stderr: The captured error text.
        inference_fn: Async callable(prompt: str) -> str for LLM inference.
    """
    if not stderr:
        return ""

    reflection_prompt = (
        "Ты — автономный отладчик. Проанализируй ошибку и сформулируй ОДНО конкретное правило-фикс.\n\n"
        f"**Задача:** {task[:300]}\n\n"
        f"**Код/контекст:**\n```\n{code[:1000]}\n```\n\n"
        f"**Ошибка (stderr):**\n```\n{stderr[:1000]}\n```\n\n"
        "Ответь ТОЛЬКО кратким правилом (1-3 предложения): что пошло не так и как это чинить."
    )

    fix_rule = ""
    if inference_fn:
        try:
            fix_rule = await inference_fn(reflection_prompt)
            fix_rule = fix_rule.strip()[:500] if fix_rule else ""
        except Exception as e:
            logger.warning("Reflection LLM call failed", error=str(e))
            fix_rule = f"[auto] Error pattern: {stderr[:200]}"
    else:
        fix_rule = f"[auto] Error pattern: {stderr[:200]}"

    if fix_rule:
        record_learning(task, stderr, fix_rule)
        logger.info("v16.4 Autonomous reflection recorded", fix_preview=fix_rule[:80])

    return fix_rule


def get_instruction_override(prompt: str) -> Tuple[Optional[List[str]], str]:
    """
    Search for dynamic instructions with #instruction tag in Claw_Logic. 
    If keywords match the prompt, return a custom chain and the instruction details.
    """
    _ensure_dirs()
    matched_instructions = []
    custom_chain = None
    
    prompt_lower = prompt.lower()
    
    for filename in os.listdir(CLAW_LOGIC_DIR):
        if not filename.endswith(".md"):
            continue
        filepath = os.path.join(CLAW_LOGIC_DIR, filename)
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                content = f.read()
            
            # Match `#instruction [kw1, kw2]`
            match = re.search(r'#instruction\s*\[(.*?)\]', content, re.IGNORECASE)
            if match:
                keywords = [k.strip().lower() for k in match.group(1).split(',')]
                # Check if any keyword is in the prompt
                if any(kw in prompt_lower for kw in keywords if kw):
                    matched_instructions.append(f"Source [{filename}]:\n{content}")
                    
                    # Look for `chain: ["Planner", "Coder"]`
                    chain_match = re.search(r'chain:\s*(\[.*?\])', content, re.IGNORECASE|re.DOTALL)
                    if chain_match and not custom_chain:
                        try:
                            # Reformat string to strictly parse json or ast if needed
                            # Assuming basic `["Planner", "Coder"]`
                            tmp_chain = json.loads(chain_match.group(1))
                            if isinstance(tmp_chain, list):
                                custom_chain = tmp_chain
                                logger.info("Found custom chain override via Obsidian instruction", chain=custom_chain, file=filename)
                        except Exception:
                            logger.warning("Failed to parse custom chain JSON", file=filename)
                            
        except Exception as e:
            logger.warning("Failed to process instruction file", error=str(e), file=filename)
            
    if matched_instructions:
        return custom_chain, "\n\n[OBSIDIAN OVERRIDE INSTRUCTIONS]\n" + "\n\n".join(matched_instructions)
    return None, ""

def _tokenize(text: str) -> set:
    # [^\W_]+ splits on underscores and non-alphanumeric so filenames like
    # "Dmarket_Core.md" correctly yield {"dmarket", "core"} not {"dmarket_core"}.
    words = re.findall(r'[^\W_]+', text.lower())
    return set(w for w in words if len(w) > 3)

def get_neural_connection(prompt: str) -> str:
    """Implement GraphRAG/Semantic Cross-Linking natively to jump through graph."""
    _ensure_dirs()
    obsidian_root = OBSIDIAN_DIR
    if not os.path.exists(obsidian_root):
        return ""
    
    prompt_tokens = _tokenize(prompt)
    if not prompt_tokens:
        return ""
        
    global_protocols = ""
    # v16.2 Read Protocols globally
    if os.path.exists(VAULT_MAP["Protocols"]):
        for fname in os.listdir(VAULT_MAP["Protocols"]):
            if fname.endswith(".md"):
                try:
                    with open(os.path.join(VAULT_MAP["Protocols"], fname), "r", encoding="utf-8") as proto_file:
                        global_protocols += f"\n## Protocol: {fname}\n{proto_file.read()[:1000]}\n"
                except Exception:
                    pass
    if global_protocols:
        global_protocols = "\n\n[GLOBAL VAULT PROTOCOLS]" + global_protocols
    
    best_matches = []
    for root_dir, dirs, files in os.walk(obsidian_root):
        # Exclude internal logic directories and git
        if "claw_logic" in root_dir or ".git" in root_dir:
            continue
        for f in files:
            if not f.endswith(".md"): continue
            if f == "Learning_Log.md": continue
            
            fpath = os.path.join(root_dir, f)
            try:
                with open(fpath, "r", encoding="utf-8") as file_obj:
                    content = file_obj.read()
                    
                title_tokens = _tokenize(f)
                content_tokens = _tokenize(content)
                
                # Title matches are weighted heavily (to find "PyO3", "HMAC")
                score = len(prompt_tokens.intersection(title_tokens)) * 5.0
                score += len(prompt_tokens.intersection(content_tokens)) * 0.5
                
                # Only include if score is decent
                if score >= 2.0:
                    rel_path = os.path.relpath(fpath, obsidian_root)
                    best_matches.append((score, f, rel_path, content))
            except Exception:
                pass

    best_matches.sort(key=lambda x: x[0], reverse=True)
    top_matches = best_matches[:2] # Top 2 matches
    
    result = global_protocols
    if top_matches:
        parts = []
        for score, title, rel, content in top_matches:
            logger.info("Semantic Cross-Linking found Note", note=title, score=score)
            snippet = content[:800] # trunc
            # Provide exact anchor/doc source so Citation Grounding can pick it up
            parts.append(f"## {title}\n(Source: {rel})\n{snippet}")
        
        result += "\n\n[NEURAL CONNECTION: СВЯЗАННЫЕ ЗНАНИЯ ИЗ OBSIDIAN]\n" + "\n\n---\n\n".join(parts) + "\n"
        
    return result

def check_learning_log(prompt: str) -> str:
    """Read last 10 entries of Learning_Log.md. If prompt is similar to an error entry, return instruction."""
    if not os.path.exists(LEARNING_LOG_PATH):
        return ""
        
    prompt_tokens = _tokenize(prompt)
    if not prompt_tokens:
        return ""
        
    try:
        with open(LEARNING_LOG_PATH, "r", encoding="utf-8") as f:
            lines = f.readlines()
            
        data_lines = [line for line in lines if line.strip() and not line.startswith("|---") and not line.startswith("| Task")]
        last_10 = data_lines[-10:]
        
        for line in reversed(last_10):
            cols = [c.strip() for c in line.split("|") if c.strip()]
            if len(cols) >= 3:
                task, error, fix = cols[0], cols[1], cols[2]
                
                task_tokens = _tokenize(task)
                overlap = len(prompt_tokens.intersection(task_tokens))
                
                # If high overlap and not a generic success
                if overlap >= max(2, len(prompt_tokens)*0.3) and "Success" not in error:
                    logger.info("Recursive Self-Reflection triggered", match=task)
                    return f"\n\n[RECURSIVE SELF-REFLECTION]\nВ прошлый раз ты ошибся здесь: {error}\nИсправь это сразу: {fix}\n"
    except Exception as e:
        logger.warning("Failed to check Learning Log", error=str(e))
        
    return ""

def auto_tag_snippet(task: str, code: str):
    """Automatically save successful code to .obsidian/Knowledge/Snippets/."""
    try:
        import uuid
        if not code or len(code) < 20: return
        
        # Determine if code logic executed
        is_code = "rust" in task.lower() or "python" in task.lower() or "код" in task.lower()
        if not is_code and "```" not in code:
            return
            
        snippets_dir = os.path.join(OBSIDIAN_DIR, "Knowledge", "Snippets")
        os.makedirs(snippets_dir, exist_ok=True)
        
        tokens = _tokenize(task)
        tags = " ".join([f"#{t}" for t in tokens if len(t) > 3][:5])
        
        snippet_id = uuid.uuid4().hex[:8]
        filepath = os.path.join(snippets_dir, f"Snippet_{snippet_id}.md")
        
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(f"Task: {task}\nTags: {tags}\n\n{code}")
            
        logger.info("Dynamic Auto-Tagging saved snippet", snippet_id=snippet_id, path=filepath)
    except Exception as e:
        logger.error("Auto-tagging failed", error=str(e))


def perform_gap_analysis() -> str:
    """v16.3: Self-Audit — compare brigades/tools with existing Knowledge docs.

    Returns the content of the generated Need_Knowledge.md or a summary.
    """
    _ensure_dirs()
    try:
        config_path = os.path.join(_project_root, "config", "openclaw_config.json")
        if not os.path.exists(config_path):
            return "Config not found — cannot perform gap analysis."

        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.loads(os.path.expandvars(f.read()))

        brigades = list(cfg.get("brigades", {}).keys())
        # Collect MCP tool names from all brigades
        mcp_tools: set[str] = set()
        for b_data in cfg.get("brigades", {}).values():
            for r_data in b_data.get("roles", {}).values():
                mcp_tools.update(r_data.get("tools", []))

        # Scan existing concept files
        concepts_dir = VAULT_MAP["Concepts"]
        existing_files = set()
        if os.path.isdir(concepts_dir):
            existing_files = {f.lower() for f in os.listdir(concepts_dir) if f.endswith(".md")}
        existing_text = " ".join(existing_files)

        gaps: list[str] = []
        for brigade in brigades:
            token = brigade.lower().replace("-", "_")
            if not any(token in ef or brigade.lower() in ef for ef in existing_files):
                gaps.append(
                    f"- **{brigade}**: Нет документа в Knowledge/Concepts/. "
                    f"Какие правила, API, ограничения у этой бригады?"
                )

        for tool in sorted(mcp_tools):
            if tool.lower() not in existing_text:
                gaps.append(f"- **Tool: {tool}**: Нет описания в Knowledge/Concepts/.")

        if not gaps:
            return "✅ Gap Analysis: все бригады и инструменты документированы."

        content = (
            "# Need Knowledge — Gap Analysis\n"
            f"#v16_knowledge\n\n"
            f"Обнаружены пробелы в базе знаний ({len(gaps)})::\n\n"
            + "\n".join(gaps)
            + "\n\n---\n_Сгенерировано автоматически perform_gap_analysis()_\n"
        )

        out_path = os.path.join(concepts_dir, "Need_Knowledge.md")
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(content)

        logger.info("Gap analysis complete", gaps=len(gaps), path=out_path)
        return content
    except Exception as e:
        logger.error("Gap analysis failed", error=str(e))
        return f"Gap analysis error: {e}"


def save_teaching(text: str) -> str:
    """v16.3: Save user-provided teaching directly to Knowledge/Concepts/.

    Returns confirmation message.
    """
    _ensure_dirs()
    try:
        import hashlib
        # Derive a short filename from content hash
        slug = hashlib.md5(text.encode()).hexdigest()[:8]
        filename = f"Teaching_{slug}.md"
        filepath = os.path.join(VAULT_MAP["Concepts"], filename)

        content = f"# Teaching Note\n#v16_knowledge\n\n{text.strip()}\n"
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)

        logger.info("Teaching saved to Obsidian", path=filepath)
        return f"✅ Знание сохранено: {filename}"
    except Exception as e:
        logger.error("save_teaching failed", error=str(e))
        return f"❌ Ошибка сохранения: {e}"


def get_knowledge_status() -> str:
    """v16.3: Return a summary of knowledge base stats."""
    _ensure_dirs()
    try:
        # Count concept files
        concepts_dir = VAULT_MAP["Concepts"]
        concept_count = len([f for f in os.listdir(concepts_dir) if f.endswith(".md")]) if os.path.isdir(concepts_dir) else 0

        # Count snippet files
        snippets_dir = VAULT_MAP["Snippets"]
        snippet_count = len([f for f in os.listdir(snippets_dir) if f.endswith(".md")]) if os.path.isdir(snippets_dir) else 0

        # Count learning log entries
        error_count = 0
        if os.path.exists(LEARNING_LOG_PATH):
            with open(LEARNING_LOG_PATH, "r", encoding="utf-8") as f:
                error_count = sum(1 for line in f if line.startswith("|") and "Task" not in line and "---" not in line)

        # Count protocol files
        protocols_dir = VAULT_MAP["Protocols"]
        protocol_count = len([f for f in os.listdir(protocols_dir) if f.endswith(".md")]) if os.path.isdir(protocols_dir) else 0

        return (
            f"📊 **Статус базы знаний**\n"
            f"• Концепты: {concept_count}\n"
            f"• Сниппеты: {snippet_count}\n"
            f"• Протоколы: {protocol_count}\n"
            f"• Ошибок зафиксировано: {error_count}"
        )
    except Exception as e:
        return f"❌ Ошибка чтения статуса: {e}"


def get_recent_knowledge(max_age_seconds: int = 3600) -> str:
    """v16.3: Return entries from Learning_Log.md and API_Fixes.md modified < max_age_seconds ago.

    Used by the pipeline to give fresh knowledge highest priority.
    """
    import time as _time
    now = _time.time()
    parts: list[str] = []

    for path, label in [
        (LEARNING_LOG_PATH, "Learning_Log"),
        (os.path.join(VAULT_MAP["Concepts"], "API_Fixes.md"), "API_Fixes"),
    ]:
        if not os.path.exists(path):
            continue
        try:
            mtime = os.path.getmtime(path)
            if (now - mtime) > max_age_seconds:
                continue
            with open(path, "r", encoding="utf-8") as f:
                content = f.read()
            if content.strip():
                parts.append(f"## {label} (обновлено <1ч назад)\n{content[-2000:]}")
        except Exception:
            pass

    if not parts:
        return ""
    return (
        "\n\n[FRESH KNOWLEDGE — ПРИОРИТЕТ НАД СИСТЕМНЫМИ ПРОМПТАМИ]\n"
        + "\n\n".join(parts)
        + "\n"
    )
