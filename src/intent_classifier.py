"""
LLM-based intent classification for routing user prompts to brigades.

Extracted from OpenClawGateway to keep main.py under 500 LOC.
"""

import re

import structlog

from src.llm_gateway import route_llm

logger = structlog.get_logger("IntentClassifier")


async def classify_intent(gateway, prompt: str) -> str:
    """
    LLM-based intent classification.
    Uses model from config (model_router.risk_analysis) for routing.
    Falls back to keyword matching if vLLM is unavailable.

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

    # Check cache first (capped at 500 entries to prevent memory leak)
    cache_key = prompt.lower().strip()[:100]
    if cache_key in gateway._intent_cache:
        return gateway._intent_cache[cache_key]
    if len(gateway._intent_cache) >= 500:
        to_keep = dict(list(gateway._intent_cache.items())[-250:])
        gateway._intent_cache.clear()
        gateway._intent_cache.update(to_keep)

    # Keyword fallback (always available)
    dmarket_keywords = [
        "buy", "sell", "dmarket", "trade", "price", "hft", "arbitrage",
        "купить", "продать", "торговля", "цена", "арбитраж", "дмаркет",
        "скин", "инвентарь", "skin", "inventory", "target", "spread",
        "offer", "listing", "profit", "margin", "предложение",
        "маржа", "профит", "листинг",
    ]
    openclaw_keywords = [
        "config", "конфиг", "pipeline", "модел", "model", "vllm",
        "бригад", "brigade", "роль", "role", "mcp", "плагин", "plugin",
        "бот", "bot", "openclaw", "gateway", "память", "memory",
        # CLI tool execution keywords → always needs full pipeline with run_command
        "clawhub", "npx", "pnpm dlx", "bunx", "npm install", "npm run",
        "npx clawhub", "install sonos", "install sono", "@latest",
        "проверь команд", "запусти команд", "выполни команд",
        "подключи", "подключена ли", "подключен ли", "проверь подключен",
        "установи", "проверь установ", "запусти", "выполни",
        # Agent / persona / debug / research routing
        "agent", "persona", "агент", "персон",
        "debug", "отлад", "research", "исследов",
        "openrouter", "опенроутер",
    ]
    # Web/research triggers → full OpenClaw pipeline with websearch MCP available
    web_research_keywords = [
        "deep research", "глубокий анализ", "найди в интернете", "найди в сети",
        "поищи в интернете", "поищи в сети", "веб-поиск", "вебпоиск",
        "найди информацию о", "прочитай статью", "открой ссылку",
        "перейди по ссылке", "загрузи страницу", "проверь сайт",
    ]
    lower_prompt = prompt.lower()
    has_url = bool(re.search(r'https?://', lower_prompt))
    if any(kw in lower_prompt for kw in dmarket_keywords):
        keyword_result = "Dmarket-Dev"
    elif has_url or any(kw in lower_prompt for kw in web_research_keywords):
        keyword_result = "Research-Ops"
    elif any(kw in lower_prompt for kw in openclaw_keywords):
        keyword_result = "OpenClaw-Core"
    else:
        keyword_result = "General"

    # Try LLM-based classification
    classify_model = (
        gateway.config.get("system", {}).get("model_router", {}).get("risk_analysis")
        or next(
            (
                d["model"]
                for brigade in gateway.config.get("brigades", {}).values()
                for d in brigade.get("roles", {}).values()
            ),
            "llama3.2",
        )
    )

    try:
        brigades = list(gateway.config.get("brigades", {}).keys())
        all_classes = brigades + ["General"]
        classify_prompt = (
            f"Classify this user request into ONE of these categories: {', '.join(all_classes)}.\n"
            f"Dmarket-Dev = trading, buying, selling items, prices, market, skins, inventory.\n"
            f"OpenClaw-Core = system administration, framework, configuration, models, bots, pipeline, "
            f"CLI commands execution (npx, pnpm, bunx, npm), clawhub, installing packages, "
            f"running shell commands, checking connections, verifying installations.\n"
            f"Research-Ops = web search, research, URLs, browsing the internet, fetching URLs, "
            f"deep research, analysis, reports, benchmarks.\n"
            f"General = general questions, chitchat, greetings, unrelated topics, unclear intent.\n\n"
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
                    gateway._intent_cache[cache_key] = b
                    logger.info("Intent classified by LLM Gateway", brigade=b, raw_response=raw)
                    return b
    except Exception as e:
        logger.warning("LLM intent classification failed, using keyword fallback", error=str(e))

    gateway._intent_cache[cache_key] = keyword_result
    logger.info("Intent classified by keywords", brigade=keyword_result, keyword_class=keyword_result)
    return keyword_result
