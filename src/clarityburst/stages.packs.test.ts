/**
 * Runtime Invariant Test: Stage ID ↔ Ontology Pack Consistency
 *
 * This test ensures that every stage ID declared in ALL_STAGE_IDS has:
 * 1. A corresponding ontology pack file at ontology-packs/<STAGE_ID>.json
 * 2. A loadable pack via getPackForStage() with matching stage_id
 *
 * This prevents "stage added but pack missing" drift.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { ALL_STAGE_IDS, type ClarityBurstStageId } from "./stages";
import {
  getPackForStage,
  getAvailableStageIds,
  validatePackObject,
  PackPolicyIncompleteError,
  PACK_POLICY_INCOMPLETE,
} from "./pack-registry";

// ESM-compatible way to get __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ONTOLOGY_PACKS_DIR = path.resolve(__dirname, "../../ontology-packs");

describe("Stage ID ↔ Ontology Pack Consistency", () => {
  describe("ALL_STAGE_IDS completeness", () => {
    it("should have ALL_STAGE_IDS defined and non-empty", () => {
      expect(ALL_STAGE_IDS).toBeDefined();
      expect(Array.isArray(ALL_STAGE_IDS)).toBe(true);
      expect(ALL_STAGE_IDS.length).toBeGreaterThan(0);
    });
  });

  describe("each stage ID has a corresponding ontology pack file", () => {
    for (const stageId of ALL_STAGE_IDS) {
      it(`should have pack file for stage "${stageId}"`, () => {
        const expectedPackPath = path.join(ONTOLOGY_PACKS_DIR, `${stageId}.json`);
        const fileExists = fs.existsSync(expectedPackPath);

        expect(
          fileExists,
          `Missing ontology pack file: ${expectedPackPath}\n` +
            `Stage "${stageId}" is declared in ALL_STAGE_IDS but has no corresponding pack file.\n` +
            `To fix: Create the file at ontology-packs/${stageId}.json`
        ).toBe(true);
      });
    }
  });

  describe("getPackForStage() succeeds for every stage ID", () => {
    for (const stageId of ALL_STAGE_IDS) {
      it(`should load pack for stage "${stageId}" with matching stage_id`, () => {
        // This will throw if the pack is not found or invalid
        const pack = getPackForStage(stageId);

        // Verify the pack is properly structured
        expect(pack).toBeDefined();
        expect(pack.stage_id).toBe(stageId);
        expect(pack.pack_id).toBeDefined();
        expect(pack.pack_version).toBeDefined();
        expect(pack.thresholds).toBeDefined();
        expect(pack.contracts).toBeDefined();
        expect(Array.isArray(pack.contracts)).toBe(true);
        expect(pack.field_schema).toBeDefined();
      });
    }
  });

  describe("bidirectional consistency: registry ↔ ALL_STAGE_IDS", () => {
    it("should have all registry stage IDs in ALL_STAGE_IDS", () => {
      const registryStageIds = getAvailableStageIds();

      for (const registryStageId of registryStageIds) {
        expect(
          (ALL_STAGE_IDS as readonly string[]).includes(registryStageId),
          `Stage "${registryStageId}" is in the registry but NOT in ALL_STAGE_IDS.\n` +
            `To fix: Add "${registryStageId}" to ALL_STAGE_IDS in stages.ts`
        ).toBe(true);
      }
    });

    it("should have all ALL_STAGE_IDS in the registry", () => {
      const registryStageIds = getAvailableStageIds();

      for (const stageId of ALL_STAGE_IDS) {
        expect(
          registryStageIds.includes(stageId),
          `Stage "${stageId}" is in ALL_STAGE_IDS but NOT in the registry.\n` +
            `The pack file might be missing or invalid.\n` +
            `To fix: Create/fix ontology-packs/${stageId}.json`
        ).toBe(true);
      }
    });

    it("should have exact count match between ALL_STAGE_IDS and registry", () => {
      const registryStageIds = getAvailableStageIds();
      expect(registryStageIds.length).toBe(ALL_STAGE_IDS.length);
    });
  });

  describe("pack file content validation", () => {
    for (const stageId of ALL_STAGE_IDS) {
      it(`should have valid JSON in pack file for stage "${stageId}"`, () => {
        const packPath = path.join(ONTOLOGY_PACKS_DIR, `${stageId}.json`);

        // Read and parse file content
        let content: string;
        try {
          content = fs.readFileSync(packPath, "utf-8");
        } catch (err) {
          throw new Error(
            `Failed to read pack file for stage "${stageId}": ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }

        // Parse JSON
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch (err) {
          throw new Error(
            `Invalid JSON in pack file for stage "${stageId}": ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }

        // Verify stage_id in the file matches the filename
        expect(typeof parsed).toBe("object");
        expect(parsed).not.toBeNull();
        const packObj = parsed as Record<string, unknown>;
        expect(
          packObj.stage_id,
          `Pack file ${stageId}.json has stage_id="${packObj.stage_id}" but filename suggests "${stageId}"`
        ).toBe(stageId);
      });
    }
  });
});

/**
 * Snapshot test: documents the current set of stage IDs.
 * If this fails, it means stage IDs were added/removed and
 * this snapshot needs to be updated intentionally.
 */
describe("Stage ID snapshot", () => {
  it("should match the expected list of stage IDs", () => {
    // Sort for deterministic comparison
    const sortedStageIds = [...ALL_STAGE_IDS].sort();
    expect(sortedStageIds).toMatchInlineSnapshot(`
      [
        "BROWSER_AUTOMATE",
        "CANVAS_UI",
        "CRON_SCHEDULE",
        "FILE_SYSTEM_OPS",
        "MEDIA_GENERATE",
        "MEMORY_MODIFY",
        "MESSAGE_EMIT",
        "NETWORK_IO",
        "NODE_INVOKE",
        "SHELL_EXEC",
        "SUBAGENT_SPAWN",
        "TOOL_DISPATCH_GATE",
      ]
    `);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PACK_POLICY_INCOMPLETE Fail-Closed Tests
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tests for fail-closed validation behavior.
 * Ensures that malformed packs trigger deterministic PACK_POLICY_INCOMPLETE errors.
 */
describe("PACK_POLICY_INCOMPLETE fail-closed validation", () => {
  const TEST_FIXTURES_DIR = path.resolve(__dirname, "./test-fixtures");

  describe("malformed pack triggers deterministic error", () => {
    it("should throw PackPolicyIncompleteError for pack with missing capability_requirements", () => {
      // Load the deliberately malformed test fixture
      const malformedPackPath = path.join(TEST_FIXTURES_DIR, "malformed-pack.json");
      const rawContent = fs.readFileSync(malformedPackPath, "utf-8");
      const malformedPack = JSON.parse(rawContent);

      // Attempt to validate - should throw deterministic error
      expect(() => validatePackObject(malformedPack, malformedPackPath)).toThrow(
        PackPolicyIncompleteError
      );

      // Verify the error is deterministic and contains expected information
      try {
        validatePackObject(malformedPack, malformedPackPath);
        // Should not reach here
        expect.fail("Expected PackPolicyIncompleteError to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(PackPolicyIncompleteError);
        const policyError = err as PackPolicyIncompleteError;

        // Verify deterministic error code
        expect(policyError.code).toBe(PACK_POLICY_INCOMPLETE);

        // Verify error message contains stage identification
        expect(policyError.message).toContain("PACK_POLICY_INCOMPLETE");
        expect(policyError.message).toContain("TEST_MALFORMED_STAGE");

        // Verify missing fields are identified
        expect(policyError.missingFields.length).toBeGreaterThan(0);

        // Verify the specific issue is identified (missing capability_requirements)
        const hasCapabilityRequirementsIssue = policyError.missingFields.some(
          (field) => field.includes("capability_requirements")
        );
        expect(
          hasCapabilityRequirementsIssue,
          `Expected error to identify missing capability_requirements. Got: ${policyError.missingFields.join(", ")}`
        ).toBe(true);
      }
    });

    it("should produce identical error message on repeated validations (determinism)", () => {
      const malformedPackPath = path.join(TEST_FIXTURES_DIR, "malformed-pack.json");
      const rawContent = fs.readFileSync(malformedPackPath, "utf-8");
      const malformedPack = JSON.parse(rawContent);

      // Validate multiple times and collect error messages
      const errorMessages: string[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          validatePackObject(malformedPack, malformedPackPath);
        } catch (err) {
          if (err instanceof PackPolicyIncompleteError) {
            errorMessages.push(err.message);
          }
        }
      }

      // All error messages should be identical (deterministic)
      expect(errorMessages.length).toBe(3);
      expect(errorMessages[0]).toBe(errorMessages[1]);
      expect(errorMessages[1]).toBe(errorMessages[2]);
    });

    it("should fail closed for pack missing required top-level fields", () => {
      const incompleteTopLevel = {
        pack_id: "test.incomplete",
        // Missing: pack_version, stage_id, contracts
      };

      expect(() =>
        validatePackObject(incompleteTopLevel, "<test-incomplete>")
      ).toThrow(PackPolicyIncompleteError);

      try {
        validatePackObject(incompleteTopLevel, "<test-incomplete>");
      } catch (err) {
        expect(err).toBeInstanceOf(PackPolicyIncompleteError);
        const policyError = err as PackPolicyIncompleteError;
        expect(policyError.code).toBe(PACK_POLICY_INCOMPLETE);
        // Should identify multiple missing fields
        expect(policyError.missingFields.length).toBeGreaterThan(0);
      }
    });

    it("should fail closed for pack with invalid contract structure", () => {
      const invalidContract = {
        pack_id: "test.invalid_contract",
        pack_version: "1.0.0",
        stage_id: "TEST_INVALID_CONTRACT",
        contracts: [
          {
            contract_id: "MISSING_FIELDS",
            // Missing: risk_class, required_fields, limits, needs_confirmation, deny_by_default, capability_requirements
          },
        ],
      };

      expect(() =>
        validatePackObject(invalidContract, "<test-invalid-contract>")
      ).toThrow(PackPolicyIncompleteError);

      try {
        validatePackObject(invalidContract, "<test-invalid-contract>");
      } catch (err) {
        expect(err).toBeInstanceOf(PackPolicyIncompleteError);
        const policyError = err as PackPolicyIncompleteError;
        expect(policyError.code).toBe(PACK_POLICY_INCOMPLETE);
        expect(policyError.message).toContain("PACK_POLICY_INCOMPLETE");
      }
    });

    it("should NOT apply silent defaults - empty capability_requirements must be explicit", () => {
      // This pack has a contract without capability_requirements
      // Under the old behavior, this would silently default to []
      // Under fail-closed, this should throw an error
      const packWithMissingCapReqs = {
        pack_id: "test.missing_cap_reqs",
        pack_version: "1.0.0",
        stage_id: "TEST_MISSING_CAP_REQS",
        contracts: [
          {
            contract_id: "CONTRACT_WITHOUT_CAP_REQS",
            risk_class: "LOW",
            required_fields: ["field1"],
            limits: {},
            needs_confirmation: false,
            deny_by_default: false,
            // Missing: capability_requirements - should NOT silently default to []
          },
        ],
      };

      // Should throw because capability_requirements is missing
      expect(() =>
        validatePackObject(packWithMissingCapReqs, "<test-no-silent-defaults>")
      ).toThrow(PackPolicyIncompleteError);
    });
  });
});
