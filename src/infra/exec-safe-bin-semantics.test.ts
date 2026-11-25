import { expect, it } from "vitest";
import {
  listRiskyConfiguredSafeBins,
  validateSafeBinSemantics,
} from "./exec-safe-bin-semantics.js";

function expectDenied(binName: string) {
  expect(validateSafeBinSemantics(binName)).toBe(false);
}

it("rejects jq programs even when configured via path-like entries", () => {
  expectDenied("jq");
  expectDenied("/usr/local/bin/jq");
});

it("rejects awk and sed variants even when configured via path-like entries", () => {
  expectDenied("/opt/homebrew/bin/gawk");
  expectDenied("C:\\Tools\\mawk.exe");
  expectDenied("nawk");
  expectDenied("/usr/local/bin/gsed");
});

it("reports normalized risky configured safe bins once per executable family member", () => {
  const awk =
    "awk-family interpreters can execute commands, access ENVIRON, and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.";
  const sed =
    "sed scripts can execute commands and write files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.";
  const jq =
    "jq can read environment data and load jq code from modules or startup files, so prefer explicit allowlist entries or approval-gated runs instead of safeBins.";
  expect(
    listRiskyConfiguredSafeBins([
      " Awk ",
      "/opt/homebrew/bin/gawk",
      "C:\\Tools\\mawk.exe",
      "nawk",
      "sed",
      "/usr/local/bin/gsed",
      "jq",
      "jq",
    ]),
  ).toEqual([
    { bin: "awk", warning: awk },
    { bin: "gawk", warning: awk },
    { bin: "gsed", warning: sed },
    { bin: "jq", warning: jq },
    { bin: "mawk", warning: awk },
    { bin: "nawk", warning: awk },
    { bin: "sed", warning: sed },
  ]);
});
