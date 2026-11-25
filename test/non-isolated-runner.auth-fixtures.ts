import path from "node:path";

export function authOwnershipFixtureFiles(
  repoRoot: string,
  fixtureRoot: string,
): Record<string, string> {
  const owner = JSON.stringify(
    path.join(repoRoot, "src", "agents", "auth-profiles", "path-resolve.ts"),
  );
  const context = `
import { createRequire } from "node:module";
const env = { ...process.env, OPENCLAW_STATE_DIR: ${JSON.stringify(path.join(fixtureRoot, "auth-ownership-state"))} };
const retainedOwner = createRequire(import.meta.url)("./dependency/node_modules/shared-auth-owner.cjs");
`;
  return {
    // A native consumer keeps the producer public getter, so replacing the
    // singleton instead of clearing its Map cannot satisfy the next file.
    "dependency/node_modules/shared-auth-owner.cjs": `
exports.remember = getter => { exports.getPreparedOwnership = getter; };
`,
    "12-auth-a-producer.test.ts": `
import { afterAll, expect, it } from "vitest";
import { getPreparedSharedAuthStoreOwnership, noteCommittedSharedAuthStoreOwnership } from ${owner};
${context}
it("pins a shared auth ownership fact through file teardown", () => {
  noteCommittedSharedAuthStoreOwnership({ location: "state-db" }, env);
  retainedOwner.remember(getPreparedSharedAuthStoreOwnership);
  expect(getPreparedSharedAuthStoreOwnership(env)).toEqual({ location: "state-db" });
});
afterAll(() => {
  expect(getPreparedSharedAuthStoreOwnership(env), "ownership must survive producer afterAll").toEqual({ location: "state-db" });
});
`,
    "12-auth-b-observer.test.ts": `
import { expect, it } from "vitest";
import { getPreparedSharedAuthStoreOwnership, prepareSharedAuthStoreOwnership } from ${owner};
${context}
it("retires prior auth facts and prepares fresh ownership", async () => {
  expect(getPreparedSharedAuthStoreOwnership(env), "prior file auth ownership must retire").toBeUndefined();
  expect(retainedOwner.getPreparedOwnership(env), "native consumers must see the same cleared owner").toBeUndefined();
  const ownership = await prepareSharedAuthStoreOwnership(env);
  expect(ownership).toEqual({ location: "legacy-main" });
  expect(getPreparedSharedAuthStoreOwnership(env)).toEqual(ownership);
  expect(retainedOwner.getPreparedOwnership(env), "native consumers must retain the ownership Map").toEqual(ownership);
});
`,
  };
}
