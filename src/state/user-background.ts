import type {
  UsersBackgroundRemoveParams,
  UsersBackgroundResult,
  UsersBackgroundUploadParams,
} from "../../packages/gateway-protocol/src/schema/users-background.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "./openclaw-state-worker-store.js";
import { normalizeUserBackgroundImage } from "./user-background-image.js";
import type {
  UserBackgroundReadCommand,
  UserBackgroundWriteInput,
} from "./user-background.types.js";
import {
  beginUserPreferenceMutation,
  captureUserPreferenceRead,
} from "./user-preferences-publication.js";

export type UserBackgroundOptions = OpenClawStateDatabaseOptions & {
  assertCurrent?: () => void;
  signal?: AbortSignal;
};

async function readBackground<Command extends UserBackgroundReadCommand>(
  context: OpenClawStateWorkerContext,
  command: Command,
  options: UserBackgroundOptions,
) {
  for (;;) {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    const isCurrent = await captureUserPreferenceRead(context.admission);
    const reply = await executeExistingOpenClawStateRead(
      { path: context.admission.databasePath, env: context.environment },
      command,
      { context, current: true, signal: options.signal },
    );
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    // An upload/removal or profile merge cannot publish stale bytes after its commit.
    if (isCurrent()) {
      return { reply, isCurrent };
    }
  }
}

export async function getUserBackground(
  profileId: string,
  options: UserBackgroundOptions = {},
): Promise<UsersBackgroundResult> {
  const { reply } = await readBackground(
    captureOpenClawStateWorkerContext(options),
    {
      type: "userBackground.snapshot",
      profileId,
    },
    options,
  );
  if (!reply) {
    return { status: "no_durable_identity" };
  }
  return reply.result;
}

export async function getUserBackgroundImage(
  profileId: string,
  assetId: string,
  options: UserBackgroundOptions & { includeBytes?: boolean } = {},
) {
  const { reply, isCurrent } = await readBackground(
    captureOpenClawStateWorkerContext(options),
    {
      type: "userBackground.image",
      profileId,
      assetId,
      includeBytes: options.includeBytes ?? true,
    },
    options,
  );
  if (!reply) {
    return { image: undefined, byteLength: undefined, isCurrent };
  }
  return { image: reply.image, byteLength: reply.byteLength, isCurrent };
}

async function mutateBackground(
  profileId: string,
  input: UsersBackgroundRemoveParams,
  imageBase64: string | undefined,
  options: UserBackgroundOptions,
): Promise<UsersBackgroundResult> {
  const context = captureOpenClawStateWorkerContext(options);
  const { reply } = await readBackground(
    context,
    { type: "userBackground.snapshot", profileId },
    options,
  );
  if (!reply) {
    return { status: "no_durable_identity" };
  }
  if (reply.result.status !== "ok" || !reply.profileId) {
    return reply.result;
  }
  const image =
    imageBase64 === undefined
      ? undefined
      : await normalizeUserBackgroundImage(imageBase64, options.signal);
  context.admission.assertCurrent();
  options.signal?.throwIfAborted();
  options.assertCurrent?.();
  const finishMutation = beginUserPreferenceMutation(context.admission);
  try {
    const mutation: UserBackgroundWriteInput = { profileId, expected: input, image };
    return await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute({ type: "userBackground.write", input: mutation }),
      {
        assertCurrent: options.assertCurrent,
        signal: options.signal,
        createAdmission: () => {
          return {
            admission: createSqliteWorkerOperationAdmission((_request, grant) => {
              context.admission.assertCurrent();
              options.signal?.throwIfAborted();
              options.assertCurrent?.();
              grant();
            }),
            nativeLocations: [context.admission.databasePath],
          };
        },
      },
    );
  } finally {
    // The worker owner joins accepted native settlement before releasing this publication fence.
    finishMutation();
  }
}

export function uploadUserBackground(
  profileId: string,
  input: UsersBackgroundUploadParams,
  options: UserBackgroundOptions = {},
): Promise<UsersBackgroundResult> {
  return mutateBackground(
    profileId,
    {
      expectedAssetId: input.expectedAssetId,
      expectedPreference: input.expectedPreference,
    },
    input.imageBase64,
    options,
  );
}

export function removeUserBackground(
  profileId: string,
  input: UsersBackgroundRemoveParams,
  options: UserBackgroundOptions = {},
): Promise<UsersBackgroundResult> {
  return mutateBackground(profileId, input, undefined, options);
}
