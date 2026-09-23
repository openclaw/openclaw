import { removeSessionFixtureDirectory } from "./session-fixture-directory.test-support.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

export async function releaseSessionTestDirectories(
  roots: Iterable<string>,
  options?: Parameters<typeof releaseGatewaySessionStoreFixture>[1],
) {
  for (const root of roots) {
    await releaseGatewaySessionStoreFixture(root, options);
  }
}

export async function removeSessionTestDirectories(roots: readonly string[]) {
  await releaseSessionTestDirectories(roots);
  await Promise.all(roots.map((dir) => removeSessionFixtureDirectory(dir)));
}

export async function removeChatTestDirectory(dir: string): Promise<void> {
  await releaseSessionTestDirectories([dir]);
  await removeSessionFixtureDirectory(dir, { maxRetries: 5, retryDelay: 50 });
}
