import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn<() => boolean>(),
  admit: vi.fn<() => void>(),
  schema: vi.fn<() => void>(),
}));
vi.mock("./openclaw-state-db-read-connection.js", () => ({
  openOpenClawStateReadConnection: () => ({
    database: { db: {}, path: "/fixture/state.sqlite" },
    close: mocks.close,
  }),
}));
vi.mock("./openclaw-state-db-dangling-workshop-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-dangling-workshop-index.js")>()),
  openDanglingWorkshopIndexReadAdmission: () => mocks.admit,
}));
vi.mock("./openclaw-state-db-schema-version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-schema-version.js")>()),
  assertSupportedStateSchemaVersion: mocks.schema,
}));

import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-readonly.js";

beforeEach(() => {
  mocks.close.mockReset().mockReturnValue(true);
  mocks.admit.mockReset();
  mocks.schema.mockReset();
});

it.each(["read", "schema"])("preserves the %s failure before reader cleanup failures", (stage) => {
  const primary = new Error(`${stage} failed`);
  const cleanup = new Error("reader close failed");
  mocks.close.mockImplementation(() => {
    throw cleanup;
  });
  if (stage === "schema") {
    mocks.schema.mockImplementation(() => {
      throw primary;
    });
  }
  let failure: unknown;
  try {
    withOpenClawStateReadOnlyLocation(
      () => {
        throw primary;
      },
      "/fixture/state.sqlite",
      "/fixture/private.sqlite",
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  expect(failure).toMatchObject({ cause: primary, errors: [primary, cleanup] });
  expect(mocks.admit).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});
