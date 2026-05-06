import { normalizeLowercaseStringOrEmpty } from "./string-coerce.js";

// Matches Qwen-family model ids that emit `reasoning_content` blocks over
// OpenAI-compatible APIs (oMLX/vLLM/llama.cpp). Replaying those historical
// reasoning blocks into follow-up requests trips strict server-side JSON
// parsers (Pydantic/FastAPI in oMLX) on unescaped control characters, causing
// 422 parse errors and empty assistant turns from turn 2 onward. (#46637)
//
// Covers the documented Qwen 3.x series plus QwQ/Qwen3-thinking variants. The
// pattern intentionally also matches `qwen3.5`, `qwen3.6`, `qwen-3`, `qwen_3`,
// and `qwq`/`qwen3-thinking` ids that appear in self-hosted deployments.
export function isQwenModelRequiringReasoningStrip(modelId?: string | null): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  if (!normalized) return false;
  // `qwen3`, `qwen-3`, `qwen_3`, `qwen3.5`, `qwen3.6`, `qwen3-coder`, `qwen3-max`, ...
  if (/(?:^|[/_:-])qwen[-_]?3(?:[._-]?\d)?(?:$|[/_.:-])/.test(normalized)) {
    return true;
  }
  // `qwq` (Qwen reasoning-specialized series).
  if (/(?:^|[/_:-])qwq(?:$|[/_.:-])/.test(normalized)) {
    return true;
  }
  return false;
}
