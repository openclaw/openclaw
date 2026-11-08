import { describe, it } from "vitest";
import {
  runWindowsPromotionCase,
  windowsPromotionCases,
} from "./test-support/windows-release-promotion.mjs";

// Real Git refs and the production CLI exercise admission and each upload boundary.
// GitHub attestation/API responses and the upload effect are fixed external fixtures.
describe("Windows release promotion", () => {
  // The executable GitHub fixture uses a POSIX shebang; native Windows proof is separate.
  it.skipIf(process.platform === "win32").each(windowsPromotionCases)(
    "%s",
    (label, scenario, uploads, refusal) => {
      runWindowsPromotionCase([label, scenario, uploads, refusal]);
    },
  );
});
