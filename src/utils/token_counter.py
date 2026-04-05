"""Centralised multilingual token estimator.

Replaces scattered ``len(text) // 4`` calls with a language-aware
heuristic that accounts for different character-to-token ratios
across scripts (Latin, Cyrillic, CJK).

Typical ratios (GPT-4/Llama tokenizers):
  - ASCII / Latin:  ~0.25 tokens per character
  - Cyrillic:       ~0.42 tokens per character
  - CJK:            ~0.55 tokens per character
"""

from __future__ import annotations

import re
from typing import Optional

# Pre-compiled character class matchers
_CYRILLIC_RE = re.compile(r"[\u0400-\u04FF]")
_CJK_RE = re.compile(
    r"[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF"
    r"\U00020000-\U0002A6DF\U0002A700-\U0002B73F]",
)

# Tokens-per-character ratios
_RATIO_ASCII = 0.25
_RATIO_CYRILLIC = 0.42
_RATIO_CJK = 0.55


def estimate_tokens(text: Optional[str]) -> int:
    """Estimate token count for *text* using script-aware heuristics.

    Returns at least 1 for any non-empty string.
    """
    if not text:
        return 0

    n_cyrillic = len(_CYRILLIC_RE.findall(text))
    n_cjk = len(_CJK_RE.findall(text))
    n_ascii = len(text) - n_cyrillic - n_cjk

    tokens = (
        n_ascii * _RATIO_ASCII
        + n_cyrillic * _RATIO_CYRILLIC
        + n_cjk * _RATIO_CJK
    )
    return max(1, int(tokens))
