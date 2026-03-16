import ANTHROPIC_MANIFEST from "../../extensions/anthropic/openclaw.plugin.json" with { type: "json" };
import BYTEPLUS_MANIFEST from "../../extensions/byteplus/openclaw.plugin.json" with { type: "json" };
import CLOUDFLARE_AI_GATEWAY_MANIFEST from "../../extensions/cloudflare-ai-gateway/openclaw.plugin.json" with { type: "json" };
import COPILOT_PROXY_MANIFEST from "../../extensions/copilot-proxy/openclaw.plugin.json" with { type: "json" };
import GITHUB_COPILOT_MANIFEST from "../../extensions/github-copilot/openclaw.plugin.json" with { type: "json" };
import GOOGLE_MANIFEST from "../../extensions/google/openclaw.plugin.json" with { type: "json" };
import HUGGINGFACE_MANIFEST from "../../extensions/huggingface/openclaw.plugin.json" with { type: "json" };
import KILOCODE_MANIFEST from "../../extensions/kilocode/openclaw.plugin.json" with { type: "json" };
import KIMI_CODING_MANIFEST from "../../extensions/kimi-coding/openclaw.plugin.json" with { type: "json" };
import MINIMAX_MANIFEST from "../../extensions/minimax/openclaw.plugin.json" with { type: "json" };
import MISTRAL_MANIFEST from "../../extensions/mistral/openclaw.plugin.json" with { type: "json" };
import MODELSTUDIO_MANIFEST from "../../extensions/modelstudio/openclaw.plugin.json" with { type: "json" };
import MOONSHOT_MANIFEST from "../../extensions/moonshot/openclaw.plugin.json" with { type: "json" };
import NVIDIA_MANIFEST from "../../extensions/nvidia/openclaw.plugin.json" with { type: "json" };
import OLLAMA_MANIFEST from "../../extensions/ollama/openclaw.plugin.json" with { type: "json" };
import OPENAI_MANIFEST from "../../extensions/openai/openclaw.plugin.json" with { type: "json" };
import OPENCODE_GO_MANIFEST from "../../extensions/opencode-go/openclaw.plugin.json" with { type: "json" };
import OPENCODE_MANIFEST from "../../extensions/opencode/openclaw.plugin.json" with { type: "json" };
import OPENROUTER_MANIFEST from "../../extensions/openrouter/openclaw.plugin.json" with { type: "json" };
import QIANFAN_MANIFEST from "../../extensions/qianfan/openclaw.plugin.json" with { type: "json" };
import QWEN_PORTAL_AUTH_MANIFEST from "../../extensions/qwen-portal-auth/openclaw.plugin.json" with { type: "json" };
import SGLANG_MANIFEST from "../../extensions/sglang/openclaw.plugin.json" with { type: "json" };
import SYNTHETIC_MANIFEST from "../../extensions/synthetic/openclaw.plugin.json" with { type: "json" };
import TOGETHER_MANIFEST from "../../extensions/together/openclaw.plugin.json" with { type: "json" };
import VENICE_MANIFEST from "../../extensions/venice/openclaw.plugin.json" with { type: "json" };
import VERCEL_AI_GATEWAY_MANIFEST from "../../extensions/vercel-ai-gateway/openclaw.plugin.json" with { type: "json" };
import VLLM_MANIFEST from "../../extensions/vllm/openclaw.plugin.json" with { type: "json" };
import VOLCENGINE_MANIFEST from "../../extensions/volcengine/openclaw.plugin.json" with { type: "json" };
import XIAOMI_MANIFEST from "../../extensions/xiaomi/openclaw.plugin.json" with { type: "json" };
import ZAI_MANIFEST from "../../extensions/zai/openclaw.plugin.json" with { type: "json" };

type ProviderAuthEnvVarManifest = {
  id?: string;
  providerAuthEnvVars?: Record<string, string[]>;
};

function collectBundledProviderAuthEnvVars(
  manifests: readonly ProviderAuthEnvVarManifest[],
): Record<string, readonly string[]> {
  const entries: Record<string, readonly string[]> = {};
  for (const manifest of manifests) {
    const providerAuthEnvVars = manifest.providerAuthEnvVars;
    if (!providerAuthEnvVars) {
      continue;
    }
    for (const [providerId, envVars] of Object.entries(providerAuthEnvVars)) {
      const normalizedProviderId = providerId.trim();
      const normalizedEnvVars = envVars.map((value) => value.trim()).filter(Boolean);
      if (!normalizedProviderId || normalizedEnvVars.length === 0) {
        continue;
      }
      entries[normalizedProviderId] = normalizedEnvVars;
    }
  }
  return entries;
}

// Read bundled provider auth env metadata from manifests so env-based auth
// lookup stays cheap and does not need to boot plugin runtime code.
export const BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES = collectBundledProviderAuthEnvVars([
  ANTHROPIC_MANIFEST,
  BYTEPLUS_MANIFEST,
  CLOUDFLARE_AI_GATEWAY_MANIFEST,
  COPILOT_PROXY_MANIFEST,
  GITHUB_COPILOT_MANIFEST,
  GOOGLE_MANIFEST,
  HUGGINGFACE_MANIFEST,
  KILOCODE_MANIFEST,
  KIMI_CODING_MANIFEST,
  MINIMAX_MANIFEST,
  MISTRAL_MANIFEST,
  MODELSTUDIO_MANIFEST,
  MOONSHOT_MANIFEST,
  NVIDIA_MANIFEST,
  OLLAMA_MANIFEST,
  OPENAI_MANIFEST,
  OPENCODE_GO_MANIFEST,
  OPENCODE_MANIFEST,
  OPENROUTER_MANIFEST,
  QIANFAN_MANIFEST,
  QWEN_PORTAL_AUTH_MANIFEST,
  SGLANG_MANIFEST,
  SYNTHETIC_MANIFEST,
  TOGETHER_MANIFEST,
  VENICE_MANIFEST,
  VERCEL_AI_GATEWAY_MANIFEST,
  VLLM_MANIFEST,
  VOLCENGINE_MANIFEST,
  XIAOMI_MANIFEST,
  ZAI_MANIFEST,
]);
