import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { secretStoreWriteAdmission } from "./secret-store-admission.js";
import type { TemplateClawHubCredentialTarget } from "./secret-store-clawhub-template.worker.js";

export async function readPersonalTemplateClawHubToken({
  profileId,
  baseUrl,
}: TemplateClawHubCredentialTarget): Promise<string | undefined> {
  const context = captureOpenClawStateReadWorkerContext();
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "templateClawHub.read", input: { profileId, baseUrl } },
    { context, current: true },
  );
  if (reply?.value !== undefined) {
    registerSecretValueForRedaction(reply.value);
  }
  context.admission.assertCurrent();
  return reply?.value;
}

/** Private sign-in does not change team aliases or publish a generic secrets event. */
export async function savePersonalTemplateClawHubToken(
  {
    profileId,
    baseUrl,
    assertCurrent,
  }: TemplateClawHubCredentialTarget & { assertCurrent: () => void },
  value: string,
): Promise<void> {
  registerSecretValueForRedaction(value);
  const context = captureOpenClawStateWorkerContext();
  await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "templateClawHub.write", input: { profileId, baseUrl, value } }),
    secretStoreWriteAdmission(context, assertCurrent),
  );
}
