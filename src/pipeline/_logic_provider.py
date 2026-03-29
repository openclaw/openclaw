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

def _ensure_dirs():
    os.makedirs(CLAW_LOGIC_DIR, exist_ok=True)

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
        
        row = f"| {task_clean} | {error_clean} | {fix_clean} |\n"
        
        # Write header if file doesn't exist or is empty
        is_new = not os.path.exists(LEARNING_LOG_PATH) or os.path.getsize(LEARNING_LOG_PATH) == 0
        
        with open(LEARNING_LOG_PATH, "a", encoding="utf-8") as f:
            if is_new:
                f.write("| Task | Error | Fix / Insight |\n")
                f.write("|---|---|---|\n")
            f.write(row)
            
        logger.info("Recorded learning log to Obsidian", task=task_clean)
    except Exception as e:
        logger.error("Failed to append to Learning_Log.md", error=str(e))

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
