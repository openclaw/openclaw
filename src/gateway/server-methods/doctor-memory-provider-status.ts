import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage as formatError } from "../../infra/errors.js";
import type { MemoryHealth } from "../../plugins/memory-provider-types.js";
import { getActiveMemoryProviderCore } from "../../plugins/memory-runtime.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export const SKIPPED_MEMORY_EMBEDDING_PROBE = {
  ok: false,
  checked: false,
  error: "memory embedding readiness not checked; run `openclaw memory status --deep` to check",
} as const;

type ProviderStatusRequest = Pick<
  GatewayRequestHandlerOptions,
  "client" | "context" | "hasCurrentClientAuthority" | "respond" | "signal"
> & {
  cfg: OpenClawConfig;
  agentId: string;
  providerId: string;
};

/** Reads provider-native memory health under the current operator request authority. */
export async function respondProviderMemoryStatus(params: ProviderStatusRequest): Promise<void> {
  const respondHealth = (health: MemoryHealth, provider = params.providerId) =>
    params.respond(
      true,
      { agentId: params.agentId, provider, health, embedding: SKIPPED_MEMORY_EMBEDDING_PROBE },
      undefined,
    );
  let open = true;
  const assertRequestCurrent = () => {
    params.signal?.throwIfAborted();
    params.client?.connectionSignal?.throwIfAborted();
    if (!open || params.client?.invalidated || params.hasCurrentClientAuthority?.() === false) {
      throw new Error("Memory status authority is no longer active");
    }
  };
  let captured: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>> = undefined;
  let provider: Awaited<ReturnType<typeof getActiveMemoryProviderCore>>["provider"] = null;
  try {
    captured = await captureGatewayOperatorRunAuthority({
      client: params.client,
      context: params.context,
      hasCurrentClientAuthority: params.hasCurrentClientAuthority,
      invocationAuthority: { assertCurrent: assertRequestCurrent, signal: params.signal },
    });
    if (!captured) {
      throw new Error("Memory provider status requires authenticated operator authority");
    }
    const authority = captured.authority;
    const assertCurrent = () => {
      assertRequestCurrent();
      authority.assertCurrent();
    };
    assertCurrent();
    const acquired = await getActiveMemoryProviderCore({
      cfg: params.cfg,
      agentId: params.agentId,
      purpose: "status",
      context: {
        authority: {
          kind: "operator",
          scopes: authority.scopes,
          connId: params.client?.connId,
        },
        assertCurrent,
        signal: params.signal,
      },
    });
    provider = acquired.provider;
    if (!provider) {
      throw new Error(acquired.error ?? `memory plugin "${params.providerId}" unavailable`);
    }
    const health = await provider.health();
    assertCurrent();
    respondHealth(health, acquired.providerId ?? params.providerId);
  } catch (err) {
    respondHealth({ status: "unavailable", message: formatError(err) });
  } finally {
    open = false;
    try {
      await provider?.close();
    } finally {
      captured?.release();
    }
  }
}
