// Reconciles a lost registration receipt, never membership or owner-key authority.
import { isDeepStrictEqual } from "node:util";
import { parseClawDescriptor } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { OpenClawIdAuthority } from "./authority.js";
import { DiscoveryRequestError, type DiscoveryClient } from "./discovery-client.js";
import { isRetryableDiscoveryError, type PublishOutcome } from "./publisher.js";

type Failure = Extract<PublishOutcome, { state: "failed" }>;

/** Restores only an account receipt tied to the exact locally committed root and signed binding. */
export async function reconcileRegistration(
  authority: OpenClawIdAuthority,
  client: DiscoveryClient,
): Promise<Failure | undefined> {
  const record = await authority.load();
  if (!record?.authority || !record.binding || record.discovery.owner_account_id) {
    return undefined;
  }
  try {
    const receipt = await client.getRegistration(record.claw_id);
    const parsed = parseClawDescriptor(receipt?.descriptor);
    // Discovery supplies the account label, but cannot replace any local signed identity fact.
    if (
      !receipt ||
      receipt.claw_id !== record.claw_id ||
      typeof receipt.owner_account_id !== "string" ||
      !receipt.owner_account_id.trim() ||
      !parsed.ok ||
      parsed.descriptor.claw_id !== record.claw_id ||
      parsed.descriptor.root_pub !== record.authority.anchor.root_pub ||
      !isDeepStrictEqual(parsed.descriptor.binding, record.binding)
    ) {
      return {
        state: "failed",
        code: "registration_mismatch",
        message: "Discovery registration does not match this claw's committed root and binding.",
        retryable: false,
      };
    }
    // The serialized authority writer rechecks the binding after the network wait.
    await authority.recordDiscovery(
      {
        owner_account_id: receipt.owner_account_id,
        published_binding_seq: record.binding.body.binding_seq,
      },
      record,
    );
    return undefined;
  } catch (error) {
    // Only a definite missing registration permits the ordinary enrollment-code path.
    if (
      error instanceof DiscoveryRequestError &&
      error.status === 404 &&
      error.code === "not_found"
    ) {
      return undefined;
    }
    return {
      state: "failed",
      code: error instanceof DiscoveryRequestError ? error.code : "registration_unavailable",
      message: error instanceof Error ? error.message : String(error),
      retryable: isRetryableDiscoveryError(error),
    };
  }
}
