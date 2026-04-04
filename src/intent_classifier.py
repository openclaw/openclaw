"""
LLM-based intent classification for routing user prompts to brigades.

Extracted from OpenClawGateway to keep main.py under 500 LOC.
v17: frozenset keywords (O(1) lookup), shared TTLCache, extracted _keyword_classify().
"""

import re

import structlog

from src.llm_gateway import route_llm
from src.utils.cache import TTLCache

logger = structlog.get_logger("IntentClassifier")

# Module-level intent cache singleton (shared across calls)
_intent_cache: TTLCache[str] = TTLCache(maxsize=500, ttl=300.0)

# Keyword sets — frozenset for O(1) membership tests
_DMARKET_KEYWORDS: frozenset[str] = frozenset({
    "buy", "sell", "dmarket", "trade", "price", "hft", "arbitrage",
    "купить", "продать", "торговля", "цена", "арбитраж", "дмаркет",
    "скин", "инвентарь", "skin", "inventory", "target", "spread",
    "offer", "listing", "profit", "margin", "предложение",
    "маржа", "профит", "листинг",
})

_OPENCLAW_KEYWORDS: frozenset[str] = frozenset({
    "config", "конфиг", "pipeline", "модел", "model",
    "бригад", "brigade", "роль", "role", "mcp", "плагин", "plugin",
    "бот", "bot", "openclaw", "gateway", "память", "memory",
    "clawhub", "npx", "pnpm dlx", "bunx", "npm install", "npm run",
    "npx clawhub", "install sonos", "install sono", "@latest",
    "проверь команд", "запусти команд", "выполни команд",
    "подключи", "подключена ли", "подключен ли", "проверь подключен",
    "установи", "проверь установ", "запусти", "выполни",
    "agent", "persona", "агент", "персон",
    "debug", "отлад", "research", "исследов",
    "openrouter", "опенроутер",
})

_WEB_RESEARCH_KEYWORDS: frozenset[str] = frozenset({
    "deep research", "глубокий анализ", "найди в интернете", "найди в сети",
    "поищи в интернете", "поищи в сети", "веб-поиск", "вебпоиск",
    "найди информацию о", "прочитай статью", "открой ссылку",
    "перейди по ссылке", "загрузи страницу", "проверь сайт",
})


def _keyword_classify(prompt: str) -> str:
    """Pure-function keyword-based intent classification.

    Returns brigade name based on keyword matching.
    NEW-5 fix: Generic coding keywords override Dmarket to prevent misrouting.
    """
    lower = prompt.lower()
    has_url = bool(re.search(r'https?://', lower))

    # NEW-5: If prompt is about generic programming without Dmarket context, skip Dmarket
    _GENERIC_CODE_KEYWORDS = {"python", "javascript", "typescript", "алгоритм", "algorithm",
                               "парсинг", "parsing", "json", "html", "css", "react", "django",
                               "flask", "fastapi", "напиши код", "напиши скрипт", "write code",
                               "write script", "функци", "function", "class ", "класс "}
    _has_generic_code = any(kw in lower for kw in _GENERIC_CODE_KEYWORDS)
    _STRONG_DMARKET = {"dmarket", "дмаркет", "cs2 скин", "cs2 skin", "hft", "арбитраж скин",
                        "торговля скин", "инвентарь dmarket"}
    _has_strong_dmarket = any(kw in lower for kw in _STRONG_DMARKET)

    if any(kw in lower for kw in _DMARKET_KEYWORDS):
        # Only route to Dmarket if no generic coding context, or strong Dmarket signal present
        if not _has_generic_code or _has_strong_dmarket:
            return "Dmarket-Dev"
    if has_url or any(kw in lower for kw in _WEB_RESEARCH_KEYWORDS):
        return "Research-Ops"
    if any(kw in lower for kw in _OPENCLAW_KEYWORDS):
        return "OpenClaw-Core"
    return "General"


async def classify_intent(gateway, prompt: str) -> str:
    """
    LLM-based intent classification.
    Uses model from config (model_router.risk_analysis) for routing.
    Falls back to keyword matching if cloud API is unavailable.

    v14.4: Fast-Intent — prefix commands bypass LLM entirely.
    """
    # v14.4: Prefix command fast-path — zero latency routing
    _PREFIX_MAP = {
        "/dmarket": "Dmarket-Dev",
        "/research": "Research-Ops",
        "/openclaw": "OpenClaw-Core",
        "/core": "OpenClaw-Core",
        "/general": "General",
    }
    stripped = prompt.strip()
    for prefix, brigade in _PREFIX_MAP.items():
        if stripped.lower().startswith(prefix):
            logger.info("Intent fast-path: prefix command", prefix=prefix, brigade=brigade)
            return brigade

    # Check shared TTL cache
    cache_key = prompt.lower().strip()[:100]
    cached = _intent_cache.get(cache_key)
    if cached is not None:
        return cached

    # Keyword fallback (always available)
    keyword_result = _keyword_classify(prompt)

    # Try LLM-based classification
    # gateway may be a real OpenClawGateway object (has .config) or a plain config dict
    _cfg = gateway.config if hasattr(gateway, "config") else gateway
    classify_model = (
        _cfg.get("system", {}).get("model_router", {}).get("risk_analysis")
        or next(
            (
                d["model"]
                for brigade in _cfg.get("brigades", {}).values()
                for d in brigade.get("roles", {}).values()
            ),
            "llama3.2",
        )
    )

    try:
        brigades = list(_cfg.get("brigades", {}).keys())
        all_classes = brigades + ["General"]
        classify_prompt = (
            f"Classify this user request into ONE of these categories: {', '.join(all_classes)}.\n"
            f"Dmarket-Dev = ONLY trading, buying/selling items on Dmarket, market prices, CS2 skins, inventory, HFT, arbitrage.\n"
            f"OpenClaw-Core = system administration, framework, configuration, models, bots, pipeline, "
            f"CLI commands execution (npx, pnpm, bunx, npm), clawhub, installing packages, "
            f"running shell commands, checking connections, verifying installations.\n"
            f"Research-Ops = web search, research, URLs, browsing the internet, fetching URLs, "
            f"deep research, analysis, reports, benchmarks.\n"
            f"General = general questions, generic programming/coding, chitchat, greetings, "
            f"unrelated topics, unclear intent. If the request is about generic coding "
            f"(Python, JavaScript, algorithms, etc.) without mentioning Dmarket/trading, classify as General.\n\n"
            f"Request: {prompt}\n\n"
            f"Reply with ONLY the category name, nothing else."
        )

        raw = await route_llm(
            classify_prompt,
            task_type="intent",
            max_tokens=16,
            temperature=0.0,
        )
        if raw:
            for b in all_classes:
                if b.lower() in raw.lower():
                    _intent_cache.put(cache_key, b)
                    logger.info("Intent classified by LLM Gateway", brigade=b, raw_response=raw)
                    return b
    except Exception as e:
        logger.warning("LLM intent classification failed, using keyword fallback", error=str(e))

    _intent_cache.put(cache_key, keyword_result)
    logger.info("Intent classified by keywords", brigade=keyword_result, keyword_class=keyword_result)
    return keyword_result
