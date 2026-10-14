import { describe, expect, it } from "vitest";
import { restoreEnvVarRefs, restoreEnvVarRefsFromResolved } from "./env-preserve.js";

function expectEnvRefArrayMutationError(action: () => unknown) {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({
    name: "EnvRefArrayMutationError",
    message: "Config write would reorder or modify an array containing environment references.",
  });
}

function entry(id: string, token: string, fields: Record<string, unknown> = {}) {
  return { id, token, ...fields };
}

const env = { TOKEN: "secret", A: "a", B: "b", FIRST: "same", SECOND: "same" };
type RestoreCase = [name: string, incoming: unknown, parsed: unknown, expected: unknown];
type RejectedCase = [name: string, incoming: unknown, parsed: unknown];

describe("restoreEnvVarRefs", () => {
  it("keeps incoming values without an authored config", () => {
    const incoming = { token: "secret" };
    expect(restoreEnvVarRefs(incoming, null, env)).toEqual(incoming);
    expect(restoreEnvVarRefs(incoming, undefined, env)).toEqual(incoming);
  });

  it("keeps edits when a missing variable cannot verify the match", () => {
    expect(restoreEnvVarRefs({ token: "edited" }, { token: "${MISSING}" }, {})).toEqual({
      token: "edited",
    });
  });

  it("restores partially resolved templates", () => {
    expect(
      restoreEnvVarRefs({ value: "secret:${MISSING}" }, { value: "${TOKEN}:${MISSING}" }, env),
    ).toEqual({ value: "${TOKEN}:${MISSING}" });
  });

  it("restores composite and escaped fallback templates", () => {
    expect(
      restoreEnvVarRefs(
        { url: "https://api.example.com/v1", literal: "${VAR:-x}" },
        { url: "https://${API_HOST:-api.example.com}/v1", literal: "$${VAR:-x}" },
        {},
      ),
    ).toEqual({ url: "https://${API_HOST:-api.example.com}/v1", literal: "$${VAR:-x}" });
  });

  it("restores a fallback template resolved from the environment", () => {
    expect(restoreEnvVarRefs({ token: "secret" }, { token: "${TOKEN:-fallback}" }, env)).toEqual({
      token: "${TOKEN:-fallback}",
    });
  });

  it("does not restore inherited parsed properties", () => {
    const parsed: unknown = Object.create({ toString: "${TOKEN}" });
    expect(restoreEnvVarRefs({ toString: "secret" }, parsed, env)).toEqual({ toString: "secret" });
  });

  it.each<RestoreCase>([
    [
      "appends after a stable scalar reference",
      ["secret", "extra"],
      ["${TOKEN}"],
      ["${TOKEN}", "extra"],
    ],
    ["replaces a unique scalar reference", ["replacement"], ["${TOKEN}"], ["replacement"]],
    [
      "edits a single object without a stable id",
      [{ name: "new", token: "secret" }],
      [{ name: "old", token: "${TOKEN}" }],
      [{ name: "new", token: "${TOKEN}" }],
    ],
    [
      "edits multiple objects with unique agentId identities",
      [
        { agentId: "first", name: "new-a", match: { peer: { id: "a" } } },
        { agentId: "second", name: "new-b", match: { peer: { id: "b" } } },
      ],
      [
        { agentId: "first", name: "old-a", match: { peer: { id: "${A}" } } },
        { agentId: "second", name: "old-b", match: { peer: { id: "${B}" } } },
      ],
      [
        { agentId: "first", name: "new-a", match: { peer: { id: "${A}" } } },
        { agentId: "second", name: "new-b", match: { peer: { id: "${B}" } } },
      ],
    ],
    [
      "edits one routing field beside an unchanged neighbor",
      [
        { accountId: "next", to: "a" },
        { accountId: "second", to: "b" },
      ],
      [
        { accountId: "old", to: "${A}" },
        { accountId: "second", to: "${B}" },
      ],
      [
        { accountId: "next", to: "${A}" },
        { accountId: "second", to: "${B}" },
      ],
    ],
    [
      "edits non-string fields while literal identities stay unchanged",
      [
        { account: "first", enabled: true, token: "a" },
        { account: "second", enabled: false, token: "b" },
      ],
      [
        { account: "first", enabled: false, token: "${A}" },
        { account: "second", enabled: true, token: "${B}" },
      ],
      [
        { account: "first", enabled: true, token: "${A}" },
        { account: "second", enabled: false, token: "${B}" },
      ],
    ],
    [
      "deletes an identified reference beside a sibling edit",
      [{ id: "keep", name: "new" }],
      [entry("drop", "${TOKEN}"), { id: "keep", name: "old" }],
      [{ id: "keep", name: "new" }],
    ],
    [
      "restores a reference retained after deletion",
      [entry("keep", "secret")],
      [{ id: "drop" }, entry("keep", "${TOKEN}")],
      [entry("keep", "${TOKEN}")],
    ],
    [
      "moves an escaped literal beside a stable real reference",
      ["secret", "literal", "${ESCAPED}"],
      ["${TOKEN}", "$${ESCAPED}", "literal"],
      ["${TOKEN}", "literal", "$${ESCAPED}"],
    ],
    [
      "restores escaped literals after stable-id moves and edits",
      [entry("literal", "plain"), entry("escaped", "${TOKEN}", { enabled: true })],
      [entry("escaped", "$${TOKEN}", { enabled: false }), entry("literal", "plain")],
      [entry("literal", "plain"), entry("escaped", "$${TOKEN}", { enabled: true })],
    ],
    [
      "restores unchanged real and escaped references without confusing them",
      ["secret", "${TOKEN}"],
      ["${TOKEN}", "$${TOKEN}"],
      ["${TOKEN}", "$${TOKEN}"],
    ],
    [
      "replaces an escaped owner without leaving an active reference",
      [entry("new", "plain")],
      [entry("old", "$${TOKEN}")],
      [entry("new", "plain")],
    ],
    [
      "changes one of multiple identical escaped literals",
      ["new", "${TOKEN}"],
      ["$${TOKEN}", "$${TOKEN}"],
      ["new", "$${TOKEN}"],
    ],
    [
      "restores an escaped literal in a same-index edit with stable neighbors",
      [{ token: "${TOKEN}", enabled: true }, "tail"],
      [{ token: "$${TOKEN}", enabled: false }, "tail"],
      [{ token: "$${TOKEN}", enabled: true }, "tail"],
    ],
  ])("%s", (_name, incoming, parsed, expected) => {
    expect(restoreEnvVarRefs(incoming, parsed, env)).toEqual(expected);
  });

  it("keeps same-valued references attached to their identities without mutating input", () => {
    const parsed = [
      entry("first", "${FIRST}", { obsolete: true }),
      entry("second", "${SECOND}", { nullable: null }),
    ];
    const incoming = [
      entry("second", "same", { nullable: null, label: "edited" }),
      entry("first", "same"),
    ];
    expect(restoreEnvVarRefs(incoming, parsed, env)).toEqual([
      entry("second", "${SECOND}", { nullable: null, label: "edited" }),
      entry("first", "${FIRST}"),
    ]);
    expect(incoming[0]?.token).toBe("same");
  });

  it.each<RejectedCase>([
    [
      "activation of an escaped literal through fallback syntax",
      [{ v: "${TOKEN:-fallback}" }, { v: "other" }],
      [{ v: "$${TOKEN}" }, { v: "other" }],
    ],
    [
      "editing an unidentified object while appending",
      [
        { name: "new", token: "secret" },
        { name: "second", token: "literal" },
      ],
      [{ name: "old", token: "${TOKEN}" }],
    ],
    [
      "identity swaps that leave secrets at their original indexes",
      [
        { account: "second", token: "a" },
        { account: "first", token: "b" },
      ],
      [
        { account: "first", token: "${A}" },
        { account: "second", token: "${B}" },
      ],
    ],
    [
      "ambiguous deletion of same-valued references with duplicate ids",
      [entry("duplicate", "same")],
      [entry("duplicate", "${FIRST}"), entry("duplicate", "${SECOND}")],
    ],
    ["renaming a real reference's stable id", [entry("new", "secret")], [entry("old", "${TOKEN}")]],
    ["scalar matches against authored literal duplicates", ["secret"], ["${TOKEN}", "secret"]],
    [
      "same-index scalar matches after restructuring",
      ["tail", "secret"],
      ["old", "${TOKEN}", "tail"],
    ],
    [
      "ambiguous escaped moves beside a new active reference",
      ["literal", "${TOKEN}", "${TOKEN}"],
      ["$${TOKEN}", "literal"],
    ],
    [
      "ambiguous multi-item escaped edits",
      [
        { token: "${A}", enabled: true },
        { token: "${B}", enabled: true },
      ],
      [
        { token: "$${A}", enabled: false },
        { token: "$${B}", enabled: false },
      ],
    ],
    [
      "escaped moves onto indexes claimed by real references",
      ["${B}", "changed"],
      ["${A}", "$${B}", "tail"],
    ],
    [
      "same-path active references masking escaped activation",
      ["changed-${TOKEN}"],
      ["${TOKEN}-$${TOKEN}"],
    ],
    [
      "active references masking escaped activation at another key",
      [{ id: "x", moved: "${TOKEN}", active: "changed" }],
      [{ id: "x", literal: "$${TOKEN}", active: "${TOKEN}" }],
    ],
    [
      "same-name active and escaped values swapped between owners",
      [entry("literal", "secret"), entry("active", "${TOKEN}")],
      [entry("literal", "$${TOKEN}"), entry("active", "${TOKEN}")],
    ],
    [
      "replacing a scalar while adding its resolved value elsewhere",
      ["replacement", "secret"],
      ["${TOKEN}", "old"],
    ],
    [
      "ambiguous same-name real and escaped scalar reorders",
      ["${TOKEN}", "secret"],
      ["${TOKEN}", "$${TOKEN}"],
    ],
  ])("rejects %s", (_name, incoming, parsed) => {
    expectEnvRefArrayMutationError(() => restoreEnvVarRefs(incoming, parsed, env));
  });
});

describe("restoreEnvVarRefsFromResolved", () => {
  const escapedAuthored = [{ id: "drop" }, entry("keep", "$${TOKEN}", { untouched: "$${OTHER}" })];
  const escapedResolved = [{ id: "drop" }, entry("keep", "${TOKEN}", { untouched: "${OTHER}" })];

  it.each([{ explicit: [["0", "token"]] }, { explicit: [["0"]] }])(
    "allows explicit escaped activation on its uniquely retained owner ($explicit)",
    ({ explicit }) => {
      const incoming = [entry("keep", "prefix-${TOKEN}", { untouched: "$${OTHER}" })];
      expect(
        restoreEnvVarRefsFromResolved(incoming, escapedAuthored, escapedResolved, explicit),
      ).toEqual(incoming);
    },
  );

  it.each([
    {
      label: "different key",
      incoming: [{ id: "keep", moved: "${TOKEN}" }],
      explicit: [["0", "moved"]],
    },
    {
      label: "different owner",
      incoming: [entry("other", "${TOKEN}")],
      explicit: [["0", "token"]],
    },
    {
      label: "wrong path",
      incoming: [entry("keep", "prefix-${TOKEN}")],
      explicit: [["0", "other"]],
    },
    {
      label: "unrelated escaped leaf",
      incoming: [entry("keep", "${TOKEN}", { untouched: "prefix-${OTHER}" })],
      explicit: [["0", "token"]],
    },
  ])("rejects explicit escaped activation with $label", ({ incoming, explicit }) => {
    expectEnvRefArrayMutationError(() =>
      restoreEnvVarRefsFromResolved(incoming, escapedAuthored, escapedResolved, explicit),
    );
  });

  it("rejects explicit escaped activation across duplicate owners", () => {
    expectEnvRefArrayMutationError(() =>
      restoreEnvVarRefsFromResolved(
        [entry("duplicate", "prefix-${TOKEN}")],
        [entry("duplicate", "$${TOKEN}"), entry("duplicate", "$${TOKEN}")],
        [entry("duplicate", "${TOKEN}"), entry("duplicate", "${TOKEN}")],
        [["0", "token"]],
      ),
    );
  });

  it("uses original resolved leaves without matching same-valued sibling literals", () => {
    const authored = {
      value: "prefix-${TOKEN}",
      edited: "${TOKEN}",
      removed: "${TOKEN}",
      literal: "$${TOKEN}",
      sibling: "read-token",
      indirect: "${INDIRECT}",
    };
    const resolved = {
      value: "prefix-read-token",
      edited: "read-token",
      removed: "read-token",
      literal: "${TOKEN}",
      sibling: "read-token",
      indirect: "${TOKEN}",
    };
    const candidate = {
      value: resolved.value,
      edited: "replacement",
      literal: resolved.literal,
      sibling: resolved.sibling,
      indirect: resolved.indirect,
    };
    expect(restoreEnvVarRefsFromResolved(candidate, authored, resolved)).toEqual({
      value: "prefix-${TOKEN}",
      edited: "replacement",
      literal: "$${TOKEN}",
      sibling: "read-token",
      indirect: "${INDIRECT}",
    });
    expect(candidate.edited).toBe("replacement");
    expect(candidate.value).toBe("prefix-read-token");
  });

  it("keeps explicit parent templates without activating untouched literal descendants", () => {
    expect(
      restoreEnvVarRefsFromResolved(
        { owner: { directory: "${OWNER}", token: "read-token" }, literal: "${OWNER}" },
        {
          owner: { directory: "$${OWNER}", token: "${TOKEN}", removed: "${TOKEN}" },
          literal: "$${OWNER}",
        },
        {
          owner: { directory: "${OWNER}", token: "read-token", removed: "read-token" },
          literal: "${OWNER}",
        },
        [["owner"]],
      ),
    ).toEqual({ owner: { directory: "${OWNER}", token: "${TOKEN}" }, literal: "$${OWNER}" });
  });
});
