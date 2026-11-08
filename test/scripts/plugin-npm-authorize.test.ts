import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it as test } from "vitest";
import { authorizeWithQuotaReset } from "../../scripts/plugin-npm-authorize.mjs";

const exhausted = () =>
  Object.assign(new Error("gh failed"), {
    stderr: "gh: API rate limit exceeded for installation ID 1. (HTTP 403)",
  });
type Options = NonNullable<Parameters<typeof authorizeWithQuotaReset>[1]>;
function fixture(overrides: Partial<Options> = {}) {
  const calls: Array<string | number> = [];
  return {
    calls,
    options: {
      authorize: () => {
        calls.push("authorize");
        return "ok";
      },
      quota: () => {
        calls.push("quota");
        return { limit: 15000, remaining: 0, reset: 160 };
      },
      now: () => 100000,
      wait: async (ms: number) => {
        calls.push(ms);
      },
      report: () => {},
      ...overrides,
    },
  };
}
test("successful authorization does not query or wait", async () => {
  const { calls, options } = fixture();
  assert.equal(await authorizeWithQuotaReset([], options), "ok");
  assert.deepEqual(calls, ["authorize"]);
});
test("quota recovery starts authorization again after the measured reset", async () => {
  const f = fixture();
  let attempts = 0;
  f.options.authorize = () => {
    f.calls.push("authorize");
    if (++attempts === 1) {
      throw exhausted();
    }
    return "fresh";
  };
  assert.equal(await authorizeWithQuotaReset([], f.options), "fresh");
  assert.deepEqual(f.calls, ["authorize", "quota", 65000, "authorize"]);
});
test("revoked authority after waiting fails without another restart", async () => {
  const revoked = new Error("permission revoked");
  const f = fixture();
  let attempts = 0;
  f.options.authorize = () => {
    throw ++attempts === 1 ? exhausted() : revoked;
  };
  await assert.rejects(authorizeWithQuotaReset([], f.options), (e) => e === revoked);
  assert.equal(attempts, 2);
});
test("a second quota failure is terminal", async () => {
  const f = fixture({
    authorize: () => {
      throw exhausted();
    },
  });
  await assert.rejects(authorizeWithQuotaReset([], f.options), /gh failed/u);
  assert.deepEqual(f.calls, ["quota", 65000]);
});
test("unrelated auth, secondary limits and non-403 errors are not retried", async () => {
  for (const text of [
    "Bad credentials (HTTP 401)",
    "secondary rate limit (HTTP 403)",
    "API rate limit exceeded for installation (HTTP 429)",
  ]) {
    const error = new Error(text);
    const f = fixture({
      authorize: () => {
        throw error;
      },
    });
    await assert.rejects(authorizeWithQuotaReset([], f.options), (e) => e === error);
    assert.deepEqual(f.calls, []);
  }
});
test("invalid or excessive quota metadata fails closed", async () => {
  for (const value of [
    { limit: 0, remaining: 0, reset: 160 },
    { limit: 1000, remaining: -1, reset: 160 },
    { limit: 1000, remaining: 1001, reset: 160 },
    { limit: 1000, remaining: 0, reset: "160" },
    { limit: 1000, remaining: 0, reset: 99999 },
  ]) {
    const f = fixture({
      authorize: () => {
        throw exhausted();
      },
      quota: (() => value) as Options["quota"],
    });
    await assert.rejects(authorizeWithQuotaReset([], f.options), /recovery bound/u);
    assert.deepEqual(f.calls, []);
  }
});
test("already-reset quota permits a single fresh attempt", async () => {
  let attempts = 0;
  const f = fixture({
    quota: () => ({ limit: 15000, remaining: 15000, reset: 99 }),
    authorize: () => {
      if (++attempts === 1) {
        throw exhausted();
      }
      return "fresh";
    },
  });
  await authorizeWithQuotaReset([], f.options);
  assert.deepEqual(f.calls, [5000]);
});
test("both publication routes run live guards after the waiting authorization", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/plugin-npm-release.yml", import.meta.url),
    "utf8",
  );
  for (const name of ["Publish with trusted publisher", "Publish approved bootstrap tarball"]) {
    const start = workflow.indexOf("- name: " + name);
    assert.ok(start >= 0, name);
    const step = workflow.slice(start, workflow.indexOf("\n      - name:", start + 1));
    assert.ok(
      step.indexOf("plugin-npm-authorize.mjs") <
        step.indexOf("release-tooling-identity.mjs verify"),
    );
    assert.ok(step.indexOf("release-tooling-identity.mjs verify") < step.indexOf("npm publish"));
  }
  assert.match(workflow, /max-parallel: 4/u);
});
