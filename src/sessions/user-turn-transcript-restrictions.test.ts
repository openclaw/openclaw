import { expect, it } from "vitest";
import { assertTranscriptSourceCommitDatabase } from "../config/sessions/transcript-source-commit-restrictions.js";
import { createUserTurnPersistenceRestrictions } from "./user-turn-transcript-restrictions.js";

const originalDatabase = { key: "file:1:2", birthtime: "3" };

it("admits the registered write owner matching the original source restriction", () => {
  const restrictions = createUserTurnPersistenceRestrictions();
  restrictions.restrictSourceDatabase(originalDatabase);
  const captured = restrictions.capture();
  expect(() =>
    assertTranscriptSourceCommitDatabase(captured.assertCurrent, originalDatabase),
  ).not.toThrow();
  expect(() =>
    assertTranscriptSourceCommitDatabase(captured.assertCurrent, {
      key: "file:1:4",
      birthtime: "3",
    }),
  ).toThrow("original physical source database");
  expect(() =>
    assertTranscriptSourceCommitDatabase(captured.assertCurrent, {
      key: "file:1:2",
      birthtime: "5",
    }),
  ).toThrow("original physical source database");
  expect(() => assertTranscriptSourceCommitDatabase(captured.assertCurrent, undefined)).toThrow(
    "original physical source database",
  );
});

it("retains source conditions added before the captured assertion reaches commit", () => {
  const restrictions = createUserTurnPersistenceRestrictions();
  const captured = restrictions.capture();
  restrictions.restrictSourceDatabase(originalDatabase);
  expect(() =>
    assertTranscriptSourceCommitDatabase(captured.assertCurrent, {
      key: "file:1:4",
      birthtime: "3",
    }),
  ).toThrow("original physical source database");
});

it("keeps the original restriction immutable and refuses conflicting callers", () => {
  const restrictions = createUserTurnPersistenceRestrictions();
  const supplied = { ...originalDatabase };
  restrictions.restrictSourceDatabase(supplied);
  supplied.key = "file:1:4";
  expect(() => restrictions.restrictSourceDatabase(originalDatabase)).not.toThrow();
  expect(() => restrictions.restrictSourceDatabase(supplied)).toThrow("restrictions conflict");
  expect(() =>
    assertTranscriptSourceCommitDatabase(restrictions.capture().assertCurrent, originalDatabase),
  ).not.toThrow();
});

it("preserves callers without a canonical physical source restriction", () => {
  const captured = createUserTurnPersistenceRestrictions().capture();
  expect(() =>
    assertTranscriptSourceCommitDatabase(captured.assertCurrent, originalDatabase),
  ).not.toThrow();
});
