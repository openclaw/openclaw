import { expect, it } from "vitest";
import native from "../../../test/fixtures/model-catalog/muse-meta-expected.json" with { type: "json" };
import { projectMetaMuseFixture } from "../../../test/helpers/meta-muse-catalog.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

it("projects the discovered Muse account without hiding recommended API/native twins or merging offerings", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "meta-muse-picker-", agentEnv: "main" },
    async (state) => {
      const result = await projectMetaMuseFixture(state.root);
      const meta = result.models.filter((row) => row.provider === "meta" && row.available);
      expect(meta).toHaveLength(8);
      expect(meta.map((row) => row.id).toSorted()).toEqual(native.map((row) => row.id).toSorted());
      expect(meta.every((row) => row.agentRuntime?.id === "muse")).toBe(true);
      expect(
        meta
          .filter((row) => row.recommended)
          .map((row) => row.id)
          .toSorted(),
      ).toEqual(["muse-spark-1.3", "muse-wonder-1.0"]);
      expect(meta.find((row) => row.id === "muse-wonder-1.0")?.name).toBe("Muse Wonder");
      expect(meta.find((row) => row.id === "muse-wonder-full-1.0-contributor")?.name).toBe(
        "Muse Wonder Full Contributor",
      );
      expect(
        result.models.find((row) => row.provider === "openrouter" && row.id === "meta/muse-wonder"),
      ).toMatchObject({
        name: "Meta: Muse Wonder",
        available: true,
      });
      expect(
        result.models.find((row) => row.provider === "openrouter" && row.id === "meta/muse-wonder")
          ?.recommended,
      ).not.toBe(true);
      expect(
        result.models.some((row) => row.provider === "openrouter" && row.id === "muse-wonder-1.0"),
      ).toBe(false);
    },
  );
});
