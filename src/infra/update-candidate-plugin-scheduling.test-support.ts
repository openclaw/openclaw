import fs from "node:fs/promises";
import path from "node:path";
import { expect, type Mock } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { prepareUpdateCandidatePluginTrees } from "./update-candidate-plugin-tree.js";

export async function pluginTreeLayout(directory: string, statePath = "snapshot") {
  const base = await fs.realpath(directory);
  const source = path.join(base, "source");
  const targetStateDir = path.join(base, statePath);
  const candidateRoot = path.join(base, "candidate");
  const destination = path.join(targetStateDir, "plugin");
  await fs.mkdir(source);
  await fs.mkdir(candidateRoot);
  return {
    base,
    source,
    destination,
    targetStateDir,
    candidateRoot,
    prepare: () =>
      prepareUpdateCandidatePluginTrees({
        roots: new Map([[source, destination]]),
        project: (file) => path.join(destination, path.relative(source, file)),
        targetStateDir,
        candidateRoot,
      }),
  };
}

export async function pluginTreeFixture(directory: string, count: number) {
  const layout = await pluginTreeLayout(directory);
  const payload = path.join(layout.source, "0.txt");
  await fs.writeFile(payload, "inventory bytes");
  for (let index = 1; index < count; index += 1) {
    await fs.link(payload, path.join(layout.source, `${index}.txt`));
  }
  return layout;
}

export async function expectDrainedWorkerFailure<Request>(
  transport: {
    run: Mock<(request: Request, options: unknown) => Promise<unknown>>;
    close: Mock<() => Promise<void>>;
  },
  options: {
    start: () => Promise<unknown>;
    failedReply: unknown;
    reply: (request: Request) => unknown;
    inspect?: (request: Request) => void;
    closeFailure?: Error;
    assertPending?: () => void;
  },
) {
  const entered = createDeferred();
  const failFirst = createDeferred();
  const firstFailed = createDeferred();
  const releasePeers = createDeferred();
  const closing = createDeferred();
  const releaseClose = createDeferred();
  let started = 0;
  let active = 0;
  let settled = false;
  transport.run.mockImplementation(async (request) => {
    options.inspect?.(request);
    const index = started++;
    active += 1;
    if (started === 4) {
      entered.resolve();
    }
    try {
      if (index === 0) {
        await failFirst.promise;
        firstFailed.resolve();
        return options.failedReply;
      }
      await releasePeers.promise;
      return options.reply(request);
    } finally {
      active -= 1;
    }
  });
  transport.close.mockImplementation(async () => {
    expect(active).toBe(0);
    closing.resolve();
    await releaseClose.promise;
    if (options.closeFailure) {
      throw options.closeFailure;
    }
  });
  const operation = options
    .start()
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await awaitGateBeforeSettlement(entered.promise, operation, "four tasks were not admitted");
    failFirst.resolve();
    await firstFailed.promise;
    expect(settled).toBe(false);
    expect(transport.close).not.toHaveBeenCalled();
    options.assertPending?.();
    releasePeers.resolve();
    await awaitGateBeforeSettlement(closing.promise, operation, "worker retirement was not joined");
    expect({ started, settled }).toEqual({ started: 4, settled: false });
    options.assertPending?.();
    releaseClose.resolve();
    return await operation;
  } finally {
    failFirst.resolve();
    releasePeers.resolve();
    releaseClose.resolve();
    await operation;
  }
}
