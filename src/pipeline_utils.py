"""
Pipeline utility functions: text cleaning, context compression,
prompt building, and chain grouping.

Extracted from pipeline_executor.py for modularity.
"""

import json
import os
import re

import structlog

logger = structlog.get_logger(__name__)


def group_chain(chain_list: list[str]) -> list[tuple[str, ...]]:
    """Groups consecutive Executor_ roles into tuples for parallel dispatch."""
    groups = []
    executor_batch = []
    for role in chain_list:
        if role.startswith("Executor_"):
            executor_batch.append(role)
        else:
            if executor_batch:
                groups.append(tuple(executor_batch))
                executor_batch = []
            groups.append((role,))
    if executor_batch:
        groups.append(tuple(executor_batch))
    return groups


def clean_response_for_user(text: str) -> str:
    """Strip internal STAR markup, <think> blocks, MCP artifacts, and process confidence tags."""
    # Remove <think>...</think> blocks
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    # v14.2: Remove leaked tool-call XML/MD tags that free models emit
    text = re.sub(r"<tool_call>.*?</tool_call>", "", text, flags=re.DOTALL)
    text = re.sub(r"<function=\w+>.*?</function>", "", text, flags=re.DOTALL)
    text = re.sub(r"\[TOOL_CALL\].*?\[/TOOL_CALL\]", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<\|tool_call\|>.*?<\|/tool_call\|>", "", text, flags=re.DOTALL)
    text = re.sub(r"```tool_call\s*\n.*?\n```", "", text, flags=re.DOTALL)
    # Remove STAR labels (SITUATION:, TASK:, ACTION:, RESULT: at line start)
    text = re.sub(r"^\s*(SITUATION|TASK|ACTION|RESULT)\s*:\s*", "", text, flags=re.MULTILINE)
    # Remove [MCP ...], [Proof of Work ...], [Correction], [PIPELINE CONTEXT ...] blocks
    text = re.sub(r"\[MCP[^\]]*\]:?[^\n]*\n?", "", text)
    text = re.sub(r"\[Proof of Work[^\]]*\]:?[^\n]*\n?", "", text)
    text = re.sub(r"\[Correction\]:?\s*", "", text)
    text = re.sub(r"\[PIPELINE CONTEXT[^\]]*\][^\n]*\n?", "", text)
    # Remove [AGENT PROTOCOL...] remnants
    text = re.sub(r"\[AGENT PROTOCOL[^\]]*\][^\n]*\n?", "", text)
    # Remove [ARCHIVIST PROTOCOL...] remnants
    text = re.sub(r"\[ARCHIVIST PROTOCOL[^\]]*\][^\n]*\n?", "", text)
    # Remove [EXECUTOR PROTOCOL...] remnants
    text = re.sub(r"\[EXECUTOR PROTOCOL[^\]]*\][^\n]*\n?", "", text)
    # Remove agent persona markers injected by AgentPersonaManager
    text = re.sub(r"\[ACTIVE AGENT PERSONA[^\]]*\][^\n]*\n?", "", text)
    text = re.sub(r"\[END AGENT PERSONA\]\s*", "", text)
    text = re.sub(r"\[USER REQUEST\]\s*", "", text)
    # Remove [RAG_CONFIDENCE: ...] tags (used internally by memory search)
    text = re.sub(r"\[RAG_CONFIDENCE:\s*\w+\]\s*", "", text)
    # Remove stray JSON tool-call artifacts outside code blocks
    text = re.sub(r'(?<!`)\{"name"\s*:.*?"arguments"\s*:.*?\}(?!`)', '', text, flags=re.DOTALL)
    # Remove repeated consecutive paragraphs (dedup)
    paragraphs = text.split('\n\n')
    seen = set()
    deduped = []
    for p in paragraphs:
        p_key = p.strip().lower()
        if p_key and p_key not in seen:
            seen.add(p_key)
            deduped.append(p)
        elif not p_key:
            deduped.append(p)
    text = '\n\n'.join(deduped)
    # Process confidence tag: [УВЕРЕННОСТЬ: X/10]
    confidence_match = re.search(r'\[УВЕРЕННОСТЬ:\s*(\d+)/10\]', text)
    if confidence_match:
        score = int(confidence_match.group(1))
        text = re.sub(r'\s*\[УВЕРЕННОСТЬ:\s*\d+/10\]\s*', '', text)
        if score < 7:
            text = '⚠️ Ответ может содержать неточности — данные частично не подтверждены.\n\n' + text
    # Collapse excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def compress_for_next_step(role_name: str, response: str) -> str:
    """
    Smart context compression: preserves JSON blocks, MCP results,
    and respects sentence boundaries instead of blind truncation.
    v13.1: head/tail truncation for large observations (>2000 chars).
    """
    # 1. Extract and preserve JSON code blocks (instructions for Executor)
    json_blocks = re.findall(r'```json\s*(.*?)\s*```', response, re.DOTALL)
    json_section = ""
    if json_blocks:
        json_section = "\n```json\n" + json_blocks[0][:800] + "\n```"

    # 2. Extract MCP execution results
    mcp_results = re.findall(r'\[MCP Execution Result\]:\n(.*?)(?:\n\n|\Z)', response, re.DOTALL)
    mcp_section = ""
    if mcp_results:
        mcp_section = "\n[MCP Result]: " + mcp_results[0][:500]

    # 3. Clean text: remove <think>, STAR labels, code blocks, MCP markers
    clean = re.sub(r'<think>.*?</think>', '', response, flags=re.DOTALL)
    clean = re.sub(r'```json.*?```', '', clean, flags=re.DOTALL)
    clean = re.sub(r'\[MCP[^\]]*\].*?\n', '', clean)
    clean = re.sub(r'\[Proof of Work[^\]]*\].*?\n', '', clean)
    clean = re.sub(r'\n{2,}', '\n', clean).strip()

    # 4. v13.1 — head/tail truncation for large observations
    max_chars = 1500
    if len(clean) > 2000:
        head = clean[:1000]
        tail = clean[-1000:]
        # try to cut at sentence boundary in head
        hb = max(head.rfind('. '), head.rfind('\n'))
        if hb > 500:
            head = head[:hb + 1]
        # try to cut at sentence boundary in tail
        tb = tail.find('. ')
        if tb != -1 and tb < 500:
            tail = tail[tb + 2:]
        clean = head + "\n[...truncated...]\n" + tail
    elif len(clean) > max_chars:
        cut = clean[:max_chars]
        last_boundary = max(cut.rfind('. '), cut.rfind('! '), cut.rfind('? '), cut.rfind('\n'))
        if last_boundary > max_chars // 2:
            cut = cut[:last_boundary + 1]
        clean = cut + "..."

    return f"[{role_name} Output]: {clean}{json_section}{mcp_section}"


def emergency_compress(step_prompt: str, ctx_threshold: int, role_name: str) -> str:
    """
    Emergency context compression when input exceeds ctx budget.
    Preserves structure: keeps [ORIGINAL USER TASK] and compresses [PIPELINE CONTEXT].
    """
    parts = step_prompt.split("[ORIGINAL USER TASK]")
    if len(parts) < 2:
        target_chars = ctx_threshold * 4
        if len(step_prompt) > target_chars:
            cut = step_prompt[:target_chars]
            last_boundary = max(cut.rfind('. '), cut.rfind('\n'), cut.rfind('? '))
            if last_boundary > target_chars // 2:
                cut = cut[:last_boundary + 1]
            return cut + "\n[...CONTEXT COMPRESSED DUE TO OVERFLOW...]"
        return step_prompt

    pipeline_ctx = parts[0]
    original_task = "[ORIGINAL USER TASK]" + parts[1]

    available_for_ctx = (ctx_threshold * 4) - len(original_task)

    if available_for_ctx < 400:
        logger.warning(f"Extreme overflow for {role_name}: dropping pipeline context entirely")
        return (
            "[PIPELINE CONTEXT — COMPRESSED]\n"
            "Previous steps completed. Details truncated due to context limit.\n\n"
            + original_task
        )

    # Aggressive compression of pipeline context
    clean_ctx = re.sub(r'<think>.*?</think>', '', pipeline_ctx, flags=re.DOTALL)
    clean_ctx = re.sub(r'```json.*?```', '[JSON_BLOCK]', clean_ctx, flags=re.DOTALL)
    clean_ctx = re.sub(r'\n{2,}', '\n', clean_ctx).strip()

    if len(clean_ctx) > available_for_ctx:
        head_size = min(400, available_for_ctx // 3)
        tail_size = available_for_ctx - head_size - 60
        head = clean_ctx[:head_size]
        tail = clean_ctx[-tail_size:] if tail_size > 0 else ""
        head_boundary = max(head.rfind('. '), head.rfind('\n'))
        if head_boundary > head_size // 2:
            head = head[:head_boundary + 1]
        tail_start = tail.find('. ')
        if tail_start > 0 and tail_start < len(tail) // 3:
            tail = tail[tail_start + 2:]
        clean_ctx = head + "\n[...COMPRESSED...]\n" + tail

    logger.info(f"Context compressed for {role_name}: {len(pipeline_ctx)} → {len(clean_ctx)} chars")
    return clean_ctx + "\n\n" + original_task


def compress_for_model_swap(steps_results: list, accumulated_context: str = "", max_tokens: int = 800) -> str:
    """Aggressive compression for cross-model context transfer.

    Produces a structured JSON string that both Qwen and DeepSeek can parse
    efficiently, preserving only actionable information.
    """
    structured = {
        "chain_so_far": [
            {"role": r.get("role", "?"), "key_output": r.get("response", "")[:200]}
            for r in steps_results[-5:]  # last 5 steps max
        ],
        "final_context": steps_results[-1].get("response", "")[:500] if steps_results else "",
    }
    raw = json.dumps(structured, ensure_ascii=False)
    # Enforce token budget (~4 chars per token)
    char_limit = max_tokens * 4
    if len(raw) > char_limit:
        raw = raw[:char_limit - 3] + "..."
    return raw


def sanitize_file_content(content: str) -> str:
    """Strip potential prompt injection markers from file content before prompt injection."""
    content = re.sub(r'(?i)\[?(system|user|assistant)\s*(prompt|message|role)\]?\s*:', '', content)
    content = re.sub(r'(?i)(ignore previous instructions|forget your instructions|new instructions:)', '[FILTERED]', content)
    content = re.sub(r'<\|im_(start|end)\|>', '', content)
    return content


# Static protocol fragments — kept as module-level constants so vLLM prefix caching
# can reuse KV-cache across requests that share the same system prompt prefix.

# Compact Kill List injected into ALL roles — prevents robotic phrasing
_KILL_LIST = (
    "\n\n[KILL LIST — ЗАПРЕЩЁННЫЕ КОНСТРУКЦИИ]"
    "\nНИКОГДА не используй: «Я как языковая модель», «Относительно моей архитектуры», "
    "«С точки зрения восприятия», философствования о цифровой природе."
    "\nНе генерируй сухие нумерованные списки там, где нужен связный живой текст."
    "\nПиши аутентично, с лёгким профессиональным сленгом."
    "\nАвтокоррекция: если начинаешь звучать как робот — одёрни себя и перефразируй."
)
_ARCHIVIST_PROTOCOL = (
    "\n\n[ARCHIVIST PROTOCOL: CRITIC + FORMATTER]"
    "\nТы получаешь технический вывод от предыдущего агента."
    "\nТвоя задача — ВЕРИФИЦИРОВАТЬ и ПЕРЕПИСАТЬ его в чистый, человекочитаемый формат."
    "\n"
    "\nФАЗА 1 — ВЕРИФИКАЦИЯ (Скептический критик):"
    "\n- Проверь ответ на ВНУТРЕННИЕ ПРОТИВОРЕЧИЯ (одно утверждение опровергает другое)."
    "\n- Проверь на ФАБРИКАЦИИ: конкретные цифры, даты, имена — есть ли основания в контексте?"
    "\n- Проверь на TOOL BYPASS: если агент описывает 'я бы выполнил команду...' вместо реального результата — отметь как непроверенное."
    "\n- Если факт НЕ подкреплён данными из контекста, УДАЛИ его, а не передавай пользователю."
    "\n"
    "\nФАЗА 2 — ФОРМАТИРОВАНИЕ:"
    "\n- Удали ВСЮ служебную разметку: SITUATION, TASK, ACTION, RESULT, <think> блоки, [MCP...], [Proof of Work...]."
    "\n- НЕ добавляй вступлений ('Давайте рассмотрим...', 'Представляет собой...')."
    "\n- Каждое предложение = конкретный ВЕРИФИЦИРОВАННЫЙ факт или вывод."
    "\n- Пиши на РУССКОМ ЯЗЫКЕ."
    "\n- Формат: прямой ответ на вопрос пользователя, без мета-комментариев."
    "\n"
    "\nФАЗА 3 — ОЦЕНКА УВЕРЕННОСТИ:"
    "\n- В САМОМ КОНЦЕ ответа добавь тег: [УВЕРЕННОСТЬ: X/10]"
    "\n  где X — твоя оценка достоверности финального ответа (10 = абсолютно уверен, подтверждено данными; 1 = полная догадка)."
    "\n- Если X < 7, ПЕРЕД основным ответом добавь: '⚠️ Ответ может содержать неточности — данные частично не подтверждены.'"
    "\n- Оценивай честно: непроверенные факты = низкая оценка."
)

_EXECUTOR_PROTOCOL = (
    "\n\n[EXECUTOR PROTOCOL — ReAct + Tool-Use]"
    "\nВыполняй задачу точно по инструкции. Результат — только JSON или код."
    "\nНикаких пояснений, вступлений, заключений."
    "\n"
    "\n[REASONING DISCIPLINE]"
    "\n- Перед каждым действием формулируй Thought: что и зачем делаешь."
    "\n- Action: выбирай ОДИН инструмент из доступных. Не выдумывай инструменты."
    "\n- Action Input: строго JSON с параметрами. Без лишнего текста."
    "\n- Если результат неожиданный — переформулируй план (Reflexion), не повторяй то же действие."
    "\n"
    "\n[TOOL SELECTION]"
    "\n- Прочитай описание каждого доступного инструмента."
    "\n- Выбирай инструмент, максимально соответствующий задаче."
    "\n- При sandbox_execute: генерируй минимальный код, проверяй успешность по exit_code."
    "\n- При ошибке sandbox: проанализируй stderr, исправь код и повтори (макс. 3 попытки)."
    "\nЯзык ответа: РУССКИЙ."
)

_KNOWLEDGE_INJECTION_CODER = (
    "\n\n[KNOWLEDGE INJECTION — v12.1 MODERN STANDARDS]\n"
    "ОБЯЗАТЕЛЬНО применяй СОВРЕМЕННЫЕ стандарты языков при генерации кода:\n"
    "\n"
    "Python 3.14:\n"
    "- Используй Deferred Evaluation (PEP 649): убери кавычки с forward-reference аннотаций.\n"
    "- Используй t-strings (PEP 750) для санитизации пользовательского ввода вместо f-strings.\n"
    "- Используй concurrent.interpreters (PEP 734) / InterpreterPoolExecutor для CPU-параллелизма.\n"
    "- Предпочитай compression.zstd вместо third-party zstandard.\n"
    "- Используй 'except ValueError, TypeError:' без скобок (PEP 758).\n"
    "- Используй int | str вместо Union[int, str].\n"
    "- Используй functools.Placeholder для частичного применения.\n"
    "\n"
    "Rust 2024 Edition:\n"
    "- Используй use<..> вместо Captures trick для RPIT lifetimes (RFC 3498).\n"
    "- Всегда пиши 'unsafe extern' для extern блоков (RFC 3484).\n"
    "- Используй #[unsafe(no_mangle)] вместо #[no_mangle].\n"
    "- Не создавай ссылки на static mut — используй addr_of!().\n"
    "- Помни: gen — зарезервированное слово, Box<[T]>.into_iter() возвращает owned T.\n"
    "- Используй Async Traits (в прелюдии 2024: Future, IntoFuture).\n"
    "\n"
    "TypeScript 5.8:\n"
    "- Используй 'as const' объекты вместо enums при --erasableSyntaxOnly.\n"
    "- Используй import ... with { type: 'json' } вместо assert.\n"
    "- Используй NoInfer<T> для контроля вывода типов generic-параметров.\n"
    "- Используй Iterator Helpers (.map/.filter/.take на IteratorObject).\n"
    "- Используй --rewriteRelativeImportExtensions для import './file.ts'.\n"
    "- Используй --isolatedDeclarations: явные return types на exports.\n"
    "- Используй нативные Set.union/intersection/difference/symmetricDifference.\n"
    "- Используй inferred type predicates в .filter() callbacks.\n"
    "\n"
    "ПРОВЕРЯЙ соответствие паттернам из special_skills.json перед финализацией кода.\n"
    "Код должен НЕ компилироваться на Python 3.10 / Rust 2021 / TypeScript 5.3 — это ЦЕЛЬ.\n"
)

_KNOWLEDGE_INJECTION_ARCHITECT = (
    "\n\n[KNOWLEDGE INJECTION — v12.1 ARCHITECTURE STANDARDS]\n"
    "При проектировании систем ОБЯЗАТЕЛЬНО учитывай:\n"
    "\n"
    "Python 3.14:\n"
    "- Проектируй CPU-интенсивные части с concurrent.interpreters (PEP 734) для обхода GIL.\n"
    "- Используй InterpreterPoolExecutor вместо ProcessPoolExecutor для меньшего overhead.\n"
    "- Используй Free-Threaded Python (PEP 703/779) для true parallelism в IO+CPU mix.\n"
    "- Используй sys.remote_exec() (PEP 768) для production debugging без перезапуска.\n"
    "\n"
    "Rust 2024:\n"
    "- Проектируй Async Traits с Future/IntoFuture из прелюдии 2024.\n"
    "- Используй use<..> bounds для управления lifetimes в RPIT.\n"
    "- Предпочитай std::sync::Mutex/OnceLock/Atomic вместо static mut.\n"
    "\n"
    "TypeScript 5.8:\n"
    "- Проектируй модули с --module nodenext и Import Attributes (with).\n"
    "- Используй --erasableSyntaxOnly для совместимости с Node.js type stripping.\n"
    "- Используй --isolatedDeclarations для параллельной emit генерации.\n"
    "- Проектируй типовую систему с NoInfer<T> для строгого вывода generics.\n"
)

_AUDITOR_PROTOCOL = (
    "\n\n[AUDITOR PROTOCOL — REFLEXION + SELF-REFLECTION]"
    "\nТы — критический рецензент. Прежде чем выдать финальный вердикт, выполни внутреннюю проверку:"
    "\n"
    "\n<self_check>"
    "\n1. Решена ли задача пользователя ПОЛНОСТЬЮ? Нет ли пропущенных требований?"
    "\n2. Есть ли фактические ошибки или противоречия в ответе предыдущих агентов?"
    "\n3. Код (если есть) — синтаксически корректен, безопасен, без hardcoded секретов?"
    "\n4. Ответ соответствует ВСЕМ требованиям исходного запроса?"
    "\n5. Нет ли галлюцинаций — ссылок на несуществующие файлы, API, библиотеки?"
    "\n6. Были ли неэффективные траектории? (одни и те же действия повторялись без прогресса)"
    "\n7. Не пропущен ли этап декомпозиции задачи на подзадачи (если задача сложная)?"
    "\n</self_check>"
    "\n"
    "\n[REFLEXION]"
    "\nЕсли verdict != pass, сформулируй конкретное reflection:"
    "\n- Что именно пошло не так в цепочке агентов?"
    "\n- Какое альтернативное действие привело бы к успеху?"
    "\n- Запиши reflection для использования в следующих итерациях."
    "\n"
    "\nПосле self_check и reflexion выдай вердикт в формате:"
    "\n- verdict: pass | fail | partial"
    "\n- issues: список обнаруженных проблем (пустой при pass)"
    "\n- reflection: что нужно изменить в стратегии (пустое при pass)"
    "\n- suggestions: конкретные предложения по улучшению"
    "\n- summary: краткое резюме проверки"
    "\nЯзык ответа: РУССКИЙ."
)


def build_role_prompt(role_name: str, role_config: dict, framework_root: str, task_type: str = None) -> str:
    """Build the system prompt for a given pipeline role with protocol injections."""
    if task_type:
        from datetime import datetime, timezone
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        return (
            f"Текущее дата и время: {now}.\n"
            "Ты — универсальный ИИ-ассистент бота OpenClaw (мульти-агентный фреймворк для разработки).\n"
            "Отвечай точно и на РУССКОМ ЯЗЫКЕ.\n\n"
            "ПРАВИЛА:\n"
            "1. Если запрос неясен, неполон или требует уточнения — верни ТОЛЬКО JSON:\n"
            '   {"action": "ask_user", "question": "твой уточняющий вопрос"}\n'
            "   Задавай не более ОДНОГО вопроса. Без лишнего текста вокруг JSON.\n"
            "2. Если вопрос конкретный — давай прямой ответ (2-5 предложений).\n"
            "3. Если информации нет или ты не уверен — честно скажи об этом. НЕ выдумывай факты.\n"
            "4. НЕ используй метки STAR/SITUATION/ACTION. НЕ описывай свои возможности без запроса.\n"
            "5. Текущее время уже известно из первой строки — используй его если нужно."
        )

    system_prompt = role_config.get("system_prompt", "You are an AI assistant.")

    is_planner = "Planner" in role_name or "Orchestrator" in role_name or "Foreman" in role_name
    is_archivist = "Archivist" in role_name
    is_auditor = "Auditor" in role_name

    if is_archivist:
        system_prompt += _ARCHIVIST_PROTOCOL
    elif is_auditor:
        system_prompt += _AUDITOR_PROTOCOL
    elif is_planner:
        os_name = "Windows" if os.name == "nt" else "Linux"
        system_prompt += (
            "\n\n[AGENT PROTOCOL: STAR-STRATEGY — INTERNAL ONLY]"
            "\n1. Memory Bank: Use .memory-bank for persistence."
            "\n2. Tooling: Если для ответа нужны данные из файловой системы, НЕМЕДЛЕННО вызывай доступные инструменты (list_directory, read_file). НЕ описывай, что ты хочешь вызвать — ВЫЗЫВАЙ."
            "\n   КОМАНДЫ В ТЕРМИНАЛЕ: Ты можешь запускать shell-команды САМОСТОЯТЕЛЬНО через инструмент run_command(command='...', workdir='.', timeout=30). "
            "Примеры: npx clawhub@latest install sonoscli, pnpm dlx ..., node --version. "
            "НЕ ПРОСИ пользователя выполнять команды — запускай их сам через run_command. "
            "Если команда завершилась ошибкой — прочитай stdout/stderr и реши проблему самостоятельно."
            "\n3. STAR используй ТОЛЬКО внутри тегов <think>...</think> для структурирования рассуждений."
            "\n4. Финальный ответ (вне <think>) должен быть ЧИСТЫМ текстом для пользователя:"
            "\n   - БЕЗ меток SITUATION/TASK/ACTION/RESULT"
            "\n   - БЕЗ повторения одних и тех же фактов в разных формулировках"
            "\n   - Каждое предложение = новый факт или конкретное действие"
            "\n   - Если задача требует инструментов и ты сгенерировал JSON — добавь его в ```json``` блок"
            "\n5. ЗАПРЕЩЁННЫЕ конструкции: 'Представляет собой...', 'Является эффективной...', 'Для конкретных рекомендаций необходимо...'"
            "\n6. SCOPE LIMITATION: Объясняй только четко установленные факты из контекста и доступных данных. Если ты НЕ УВЕРЕН — скажи 'недостаточно данных' вместо домысливания. Пропускай спорные или непроверенные области."
            "\n7. ВАЖНО: Весь ответ на РУССКОМ ЯЗЫКЕ."
            f"\n8. СИСТЕМНАЯ СРЕДА: Бот работает на {os_name}. Инструменты доступны через MCP. Для выполнения команд в терминале используй run_command — внутри бота есть shell-агент. НЕ проси пользователя запускать команды вручную."
        )

        # Inject BRAIN.md for Planners
        brain_path = os.path.join(framework_root, "BRAIN.md")
        if os.path.exists(brain_path):
            try:
                with open(brain_path, "r", encoding="utf-8") as f:
                    brain_content = f.read()
                brain_content = sanitize_file_content(brain_content)
                system_prompt += f"\n\n[LATEST BRAIN.md CONTEXT]\n{brain_content}"
            except Exception as e:
                logger.warning(f"Failed to read BRAIN.md: {e}")

        # v12.1: Inject PROJECT_CONTEXT.md for Planners and Architects
        ctx_path = os.path.join(framework_root, "PROJECT_CONTEXT.md")
        if os.path.exists(ctx_path):
            try:
                with open(ctx_path, "r", encoding="utf-8") as f:
                    ctx_content = f.read()
                ctx_content = sanitize_file_content(ctx_content[:2000])
                system_prompt += f"\n\n[PROJECT CONTEXT]\n{ctx_content}"
            except Exception as e:
                logger.warning(f"Failed to read PROJECT_CONTEXT.md: {e}")
    else:
        system_prompt += _EXECUTOR_PROTOCOL

    # v12.1: Knowledge Injection for code-producing roles
    is_coder = any(tag in role_name for tag in ["Coder", "Executor_Architect", "Executor_Tools", "Test_Writer"])
    is_architect = any(tag in role_name for tag in ["Architect", "Planner", "Foreman"])
    if is_coder:
        system_prompt += _KNOWLEDGE_INJECTION_CODER
    elif is_architect:
        system_prompt += _KNOWLEDGE_INJECTION_ARCHITECT

    # Inject Kill List into ALL roles for persona consistency
    system_prompt += _KILL_LIST

    # Inject IDENTITY.md persona cues for Archivists (human-readable output) and Planners
    if is_archivist or is_planner:
        identity_path = os.path.join(framework_root, "IDENTITY.md")
        if os.path.exists(identity_path):
            try:
                with open(identity_path, "r", encoding="utf-8") as f:
                    raw = f.read()
                # Extract only Kill List + primary persona section (compact)
                kill_section = raw.split("## 1.")[0] if "## 1." in raw else raw[:600]
                kill_section = sanitize_file_content(kill_section[:800])
                system_prompt += f"\n\n[IDENTITY CONTEXT]\n{kill_section.strip()}"
            except Exception as e:
                logger.warning(f"Failed to read IDENTITY.md: {e}")

    # v12.1: Inject PROJECT_CONTEXT.md for Architects (Planners get it above)
    if is_architect and not is_planner:
        ctx_path = os.path.join(framework_root, "PROJECT_CONTEXT.md")
        if os.path.exists(ctx_path):
            try:
                with open(ctx_path, "r", encoding="utf-8") as f:
                    ctx_content = f.read()
                ctx_content = sanitize_file_content(ctx_content[:2000])
                system_prompt += f"\n\n[PROJECT CONTEXT]\n{ctx_content}"
            except Exception as e:
                logger.warning(f"Failed to read PROJECT_CONTEXT.md: {e}")

    return system_prompt
