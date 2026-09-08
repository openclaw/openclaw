import { describe, expect, it } from "vitest";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";

describe("resolvePackageRuntimePreflight", () => {
  it("derives the upgrade hint from the target package's engine range", async () => {
    // A floor above every Node line, so this fails on any runtime the tests run under.
    const result = await resolvePackageRuntimePreflight({
      target: { version: "2027.1.0", nodeEngine: ">=90.2.0 <91 || >=92.5.0" },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toContain("The requested package requires >=90.2.0 <91 || >=92.5.0.");
    expect(result.error).toContain(
      "Upgrade to Node 90.2.0+ below 91 or Node 92.5.0+, then rerun `openclaw update`.",
    );
    expect(result.error).not.toContain("24.16.0");
  });
});
