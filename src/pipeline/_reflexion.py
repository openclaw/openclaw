"""Pipeline reflexion fallback — error recovery via self-reflection."""

from typing import Optional

import structlog

logger = structlog.get_logger(__name__)


async def reflexion_fallback(
    vllm_url: str,
    config: dict,
    prompt: str,
    error_response: str,
) -> Optional[str]:
    """Reflexion fallback — self-reflection when pipeline produces an error."""
    try:
        from src.ai.agents.reflexion import ReflexionAgent

        agent = ReflexionAgent(
            vllm_url=vllm_url,
            model=config.get("system", {}).get("model_router", {}).get(
                "general", "meta-llama/llama-3.3-70b-instruct:free"
            ),
        )
        task = (
            f"The pipeline produced an error or low-quality response for this task:\n"
            f"{prompt[:500]}\n\n"
            f"Error/response:\n{error_response[:500]}\n\n"
            f"Reflect on what went wrong and produce a corrected answer."
        )
        result = await agent.solve_with_reflection(task, max_attempts=2)
        if result and result.final_answer:
            logger.info("Reflexion fallback succeeded", attempts=result.attempts_used)
            return result.final_answer
    except Exception as e:
        logger.warning("Reflexion fallback failed", error=str(e))
    return None
