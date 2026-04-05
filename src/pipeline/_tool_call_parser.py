"""Tool Call Text Parser — intercepts XML/Markdown tool calls leaked by free models.

Free models (DeepSeek-R1, Llama-3.3, Qwen) often emit tool calls as raw text
instead of using OpenAI-native tool_calls JSON. This module parses those
leaked fragments, executes the tool, and returns a clean response.

Supported formats:
  1. <tool_call><function=name>{...}</function></tool_call>
  2. <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  3. [TOOL_CALL] {"name": "...", "arguments": {...}} [/TOOL_CALL]
  4. ```tool_call\n{...}\n```
  5. <|tool_call|> ... <|/tool_call|> (DeepSeek / Hermes format)
  6. <function=name>{...}</function>
  7. Action: name\nAction Input: {...}  (ReAct-style, Llama-3.3)
  8. <|python_tag|>{...}<|/python_tag|>  (DeepSeek-R1 code exec)
  9. ✿FUNCTION✿: name\n✿ARGS✿: {...}  (Qwen function format)
"""

import json
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class ParsedToolCall:
    """Represents a single tool call extracted from model text."""
    name: str
    arguments: Dict[str, Any]
    raw_match: str  # original matched text to strip from response


# ---- regex patterns (compiled once) ----

# <tool_call><function=web_search>{"query":"..."}</function></tool_call>
_RE_XML_FUNCTION = re.compile(
    r"<tool_call>\s*<function=(\w+)>(.*?)</function>\s*</tool_call>",
    re.DOTALL,
)

# <function=name>{"query":"..."}</function>  (no outer wrapper)
_RE_BARE_FUNCTION = re.compile(
    r"<function=(\w+)>(.*?)</function>",
    re.DOTALL,
)

# <tool_call>{"name":"...","arguments":{...}}</tool_call>
_RE_XML_JSON = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)

# [TOOL_CALL] ... [/TOOL_CALL]
_RE_BRACKET = re.compile(
    r"\[TOOL_CALL\]\s*(\{.*?\})\s*\[/TOOL_CALL\]",
    re.DOTALL | re.IGNORECASE,
)

# ```tool_call\n...\n```
_RE_CODEBLOCK = re.compile(
    r"```tool_call\s*\n(.*?)\n```",
    re.DOTALL,
)

# <|tool_call|> ... <|/tool_call|>  (Hermes/DeepSeek special tokens)
_RE_HERMES = re.compile(
    r"<\|tool_call\|>\s*(.*?)\s*<\|/tool_call\|>",
    re.DOTALL,
)

# <|python_tag|>...  (DeepSeek code-execution format)
_RE_PYTHON_TAG = re.compile(
    r"<\|python_tag\|>\s*(.*?)\s*(?:<\|/python_tag\|>|$)",
    re.DOTALL,
)

# ReAct-style: Action: tool_name\nAction Input: {...}
_RE_REACT_ACTION = re.compile(
    r"Action:\s*(\w+)\s*\nAction\s*Input:\s*(\{.*?\})\s*(?:\n|$)",
    re.DOTALL | re.IGNORECASE,
)

# Qwen ✿FUNCTION✿ format: ✿FUNCTION✿: name\n✿ARGS✿: {...}\n✿RESULT✿
_RE_QWEN_FUNCTION = re.compile(
    r"\u273F\s*FUNCTION\s*\u273F\s*:\s*(\w+)\s*\n\u273F\s*ARGS\s*\u273F\s*:\s*(\{.*?\})\s*(?:\n\u273F\s*RESULT|$)",
    re.DOTALL,
)

# Catch-all: raw JSON with "name" and "arguments" keys not inside a code block
_RE_RAW_JSON_TOOL = re.compile(
    r'(?<![`])\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{.*?\})\s*\}(?![`])',
    re.DOTALL,
)


def _safe_parse_json(text: str) -> Optional[Dict]:
    """Try to parse JSON, return None on failure."""
    text = text.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try fixing common model errors: trailing commas, single quotes
        fixed = re.sub(r",\s*([}\]])", r"\1", text)
        fixed = fixed.replace("'", '"')
        try:
            return json.loads(fixed)
        except json.JSONDecodeError:
            return None


def parse_tool_calls(text: str) -> List[ParsedToolCall]:
    """Extract all tool calls from model text output.

    Returns a list of ParsedToolCall. Empty list if no tool calls found.
    """
    results: List[ParsedToolCall] = []
    seen_ranges: List[Tuple[int, int]] = []  # avoid double-matching

    def _overlaps(start: int, end: int) -> bool:
        for s, e in seen_ranges:
            if start < e and end > s:
                return True
        return False

    # 1. <tool_call><function=name>...</function></tool_call>
    for m in _RE_XML_FUNCTION.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        fn_name = m.group(1)
        args_str = m.group(2).strip()
        args = _safe_parse_json(args_str) or {}
        results.append(ParsedToolCall(name=fn_name, arguments=args, raw_match=m.group(0)))
        seen_ranges.append((m.start(), m.end()))

    # 2. <function=name>...</function> (bare, outside tool_call wrapper)
    for m in _RE_BARE_FUNCTION.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        fn_name = m.group(1)
        args_str = m.group(2).strip()
        args = _safe_parse_json(args_str) or {}
        results.append(ParsedToolCall(name=fn_name, arguments=args, raw_match=m.group(0)))
        seen_ranges.append((m.start(), m.end()))

    # 3. <tool_call>{json}</tool_call>
    for m in _RE_XML_JSON.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        parsed = _safe_parse_json(m.group(1))
        if parsed and "name" in parsed:
            args = parsed.get("arguments", parsed.get("parameters", {}))
            if isinstance(args, str):
                args = _safe_parse_json(args) or {}
            results.append(ParsedToolCall(
                name=parsed["name"], arguments=args, raw_match=m.group(0),
            ))
            seen_ranges.append((m.start(), m.end()))

    # 4. [TOOL_CALL]...[/TOOL_CALL]
    for m in _RE_BRACKET.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        parsed = _safe_parse_json(m.group(1))
        if parsed and "name" in parsed:
            args = parsed.get("arguments", parsed.get("parameters", {}))
            if isinstance(args, str):
                args = _safe_parse_json(args) or {}
            results.append(ParsedToolCall(
                name=parsed["name"], arguments=args, raw_match=m.group(0),
            ))
            seen_ranges.append((m.start(), m.end()))

    # 5. ```tool_call\n...\n```
    for m in _RE_CODEBLOCK.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        parsed = _safe_parse_json(m.group(1))
        if parsed and "name" in parsed:
            args = parsed.get("arguments", parsed.get("parameters", {}))
            if isinstance(args, str):
                args = _safe_parse_json(args) or {}
            results.append(ParsedToolCall(
                name=parsed["name"], arguments=args, raw_match=m.group(0),
            ))
            seen_ranges.append((m.start(), m.end()))

    # 6. <|tool_call|>...<|/tool_call|>
    for m in _RE_HERMES.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        parsed = _safe_parse_json(m.group(1))
        if parsed and "name" in parsed:
            args = parsed.get("arguments", parsed.get("parameters", {}))
            if isinstance(args, str):
                args = _safe_parse_json(args) or {}
            results.append(ParsedToolCall(
                name=parsed["name"], arguments=args, raw_match=m.group(0),
            ))
            seen_ranges.append((m.start(), m.end()))

    # 7. ReAct-style: Action: tool_name\nAction Input: {...}
    for m in _RE_REACT_ACTION.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        fn_name = m.group(1)
        args = _safe_parse_json(m.group(2)) or {}
        results.append(ParsedToolCall(name=fn_name, arguments=args, raw_match=m.group(0)))
        seen_ranges.append((m.start(), m.end()))

    # 8. <|python_tag|>...  (DeepSeek code generation)
    for m in _RE_PYTHON_TAG.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        parsed = _safe_parse_json(m.group(1))
        if parsed and "name" in parsed:
            args = parsed.get("arguments", parsed.get("parameters", {}))
            if isinstance(args, str):
                args = _safe_parse_json(args) or {}
            results.append(ParsedToolCall(
                name=parsed["name"], arguments=args, raw_match=m.group(0),
            ))
            seen_ranges.append((m.start(), m.end()))

    # 9. Qwen ✿FUNCTION✿ format
    for m in _RE_QWEN_FUNCTION.finditer(text):
        if _overlaps(m.start(), m.end()):
            continue
        fn_name = m.group(1)
        args = _safe_parse_json(m.group(2)) or {}
        results.append(ParsedToolCall(name=fn_name, arguments=args, raw_match=m.group(0)))
        seen_ranges.append((m.start(), m.end()))

    return results


def strip_tool_calls(text: str, calls: List[ParsedToolCall]) -> str:
    """Remove raw tool-call text from the response so user never sees XML tags."""
    for call in calls:
        text = text.replace(call.raw_match, "")
    # Clean up leftover whitespace from removal
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def has_tool_calls(text: str) -> bool:
    """Quick check: does the text contain any tool-call patterns?"""
    return bool(parse_tool_calls(text))


async def execute_parsed_tool_calls(
    calls: List[ParsedToolCall],
    mcp_client: Any,
    sandbox: Any = None,
) -> List[Dict[str, Any]]:
    """Execute parsed tool calls via MCP or sandbox. Returns list of results."""
    results = []
    for call in calls:
        try:
            if call.name == "sandbox_execute" and sandbox:
                payload = call.arguments
                sb_result = await sandbox.execute(
                    code=payload.get("code", ""),
                    language=payload.get("language", "python"),
                )
                results.append({
                    "tool": call.name,
                    "success": sb_result.success,
                    "output": f"exit={sb_result.exit_code} stdout={sb_result.stdout[:1500]}",
                })
            elif call.name == "analyze_youtube_video":
                from src.tools.youtube_parser import analyze_youtube_video
                url_or_id = call.arguments.get("url", call.arguments.get("query", ""))
                yt_result = await analyze_youtube_video(url_or_id)
                results.append({
                    "tool": call.name,
                    "success": yt_result.success,
                    "output": yt_result.to_context()[:2000],
                })
            elif mcp_client and hasattr(mcp_client, "call_tool"):
                tool_output = await mcp_client.call_tool(call.name, call.arguments)
                results.append({
                    "tool": call.name,
                    "success": True,
                    "output": str(tool_output)[:2000],
                })
            else:
                results.append({
                    "tool": call.name,
                    "success": False,
                    "output": f"No handler available for tool: {call.name}",
                })
        except Exception as e:
            logger.error("Tool execution failed", tool=call.name, error=str(e))
            results.append({
                "tool": call.name,
                "success": False,
                "output": f"Error: {e}",
            })
    return results


def format_observations(results: List[Dict[str, Any]]) -> str:
    """Format tool results into an Observation block for the model."""
    parts = []
    for r in results:
        status = "✅" if r.get("success") else "❌"
        parts.append(f"[Observation] {status} {r['tool']}: {r['output']}")
    return "\n".join(parts)
