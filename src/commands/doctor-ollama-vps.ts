import type { OpenClawConfig } from "../config/config.js";
import { note } from "../terminal/note.js";

/**
 * Emits a note when using Ollama in local mode, suggesting VPS setup for
 * self-hosted deployments. Keeps the message brief to avoid noise.
 */
export function noteOllamaVpsTip(cfg: OpenClawConfig): void {
  if (cfg.gateway?.mode !== "local") {
    return;
  }
  const primary = cfg.agents?.defaults?.model?.primary;
  const isOllamaPrimary =
    typeof primary === "string" && primary.toLowerCase().startsWith("ollama/");
  const hasOllamaProvider = Boolean(
    cfg.models?.providers && typeof cfg.models.providers === "object" && "ollama" in cfg.models.providers,
  );
  if (!isOllamaPrimary && !hasOllamaProvider) {
    return;
  }
  note(
    "Ollama in use. For VPS deployment: run scripts/setup-ollama-vps.sh. See docs.openclaw.ai/providers/ollama",
    "Ollama",
  );
}
