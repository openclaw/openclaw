import { expect, test } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

test.each([
  { host: "github.com", apiBaseUrl: "https://api.github.com" },
  { host: "tenant.ghe.com", apiBaseUrl: "https://api.tenant.ghe.com" },
  { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test:8443/api/v3" },
])("accepts a matching GitHub endpoint for $host", (github) => {
  expect(OpenClawSchema.safeParse({ gateway: { github } }).success).toBe(true);
});

test.each([
  { host: "ghe.example.test", apiBaseUrl: "https://api.other.example.test" },
  { host: "ghe.example.test", apiBaseUrl: "http://ghe.example.test/api/v3" },
  { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/other" },
  { host: "ghe.example.test" },
])("rejects a GitHub endpoint that could send credentials away from $host", (github) => {
  expect(OpenClawSchema.safeParse({ gateway: { github } }).success).toBe(false);
});

test("accepts a host-bound service credential for Enterprise discovery", () => {
  expect(
    OpenClawSchema.safeParse({
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
        controlUi: { github: { host: "ghe.example.test", token: "synthetic-service-token" } },
      },
    }).success,
  ).toBe(true);
});

test("accepts a provider neutral repository default", () => {
  expect(
    OpenClawSchema.safeParse({
      gateway: {
        projects: {
          defaultRepository: { url: "https://ghe.example.test/acme/private-repo.git", ref: "main" },
        },
      },
      cloudWorkers: {
        projectProfiles: { "ghe.example.test/acme/private-repo": "example-worker" },
      },
    }).success,
  ).toBe(true);
});
