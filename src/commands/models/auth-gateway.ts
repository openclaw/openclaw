import { addAbortSignal } from "node:stream";
import { readByteStreamWithLimit } from "@openclaw/media-core/read-byte-stream-with-limit";
import type { ModelsAuthSetApiKeyParams } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { ExitError } from "../../runtime.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError } from "../../wizard/prompts.js";

/** Collect input without loading local config or opening a credential store. */
export async function readGatewayApiKeyParams(
  opts: { provider?: string; agent?: string },
  signal: AbortSignal,
): Promise<ModelsAuthSetApiKeyParams> {
  let input: string;
  try {
    input = process.stdin.isTTY
      ? await createClackPrompter(process.stderr, signal).text({
          message: "Paste API key",
          sensitive: true,
        })
      : (
          await readByteStreamWithLimit(addAbortSignal(signal, process.stdin), {
            maxBytes: 1024 * 1024,
            onOverflow: ({ maxBytes }) => new Error(`Piped auth input exceeds ${maxBytes} bytes.`),
          })
        ).toString("utf8");
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      throw new ExitError(0);
    }
    throw error;
  }
  signal.throwIfAborted();
  const apiKey = normalizeSecretInput(input);
  if (!apiKey) {
    throw new Error(
      "No API key was supplied. Rerun this command and paste a non-empty API key, or pipe one to stdin.",
    );
  }
  registerSecretValueForRedaction(apiKey);
  if (!opts.provider) {
    throw new Error("Missing --provider.");
  }
  return { provider: opts.provider, apiKey, agentId: opts.agent };
}
