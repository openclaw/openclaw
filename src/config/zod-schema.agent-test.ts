/**
 * Agent test schema — defines the format for test_routing.yaml files
 * that live in agents/<name>/tests/.
 */
import { z } from "zod";

const AgentTestCaseSchema = z
  .object({
    name: z.string().min(1),
    input: z.string().min(1),
    expect_route: z.string().optional(),
    expect_not_route: z.string().optional(),
    expect_capabilities_used: z.array(z.string()).optional(),
    expect_clarification: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => data.expect_route || data.expect_not_route || data.expect_clarification !== undefined,
    {
      message:
        "Each test must have at least one expectation (expect_route, expect_not_route, or expect_clarification)",
    },
  );

export const AgentTestSuiteSchema = z
  .object({
    tests: z.array(AgentTestCaseSchema).min(1),
  })
  .strict();

export type AgentTestCase = z.infer<typeof AgentTestCaseSchema>;
export type AgentTestSuite = z.infer<typeof AgentTestSuiteSchema>;
