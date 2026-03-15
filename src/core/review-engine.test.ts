import { describe, expect, it } from "vitest";
import { DEFAULT_RADAR_DEFENDER_CONFIG } from "../context/radar-defaults.js";
import { reviewArtifact } from "./review-engine.js";

describe("reviewArtifact", () => {
  it("detects privileged service-role usage", () => {
    const result = reviewArtifact({
      artifact: {
        kind: "code-snippet",
        name: "auth-helper.ts",
        content: "const client = createServerClient(process.env.SUPABASE_SERVICE_ROLE);",
      },
      reviewConfig: DEFAULT_RADAR_DEFENDER_CONFIG.review,
    });

    expect(result.findings.some((finding) => finding.finding.includes("Privileged Supabase"))).toBe(
      true,
    );
  });

  it("detects raw error message leakage", () => {
    const result = reviewArtifact({
      artifact: {
        kind: "route",
        name: "POST /api/auth/register",
        content: "return NextResponse.json({ error: error.message }, { status: 500 });",
        metadata: { method: "POST", routePath: "/api/auth/register" },
      },
      reviewConfig: DEFAULT_RADAR_DEFENDER_CONFIG.review,
    });

    expect(result.findings.some((finding) => finding.finding.includes("Raw error.message"))).toBe(
      true,
    );
  });

  it("detects unsafe HTML rendering", () => {
    const result = reviewArtifact({
      artifact: {
        kind: "code-snippet",
        name: "message-view.tsx",
        content: "<div dangerouslySetInnerHTML={{ __html: content }} />",
      },
      reviewConfig: DEFAULT_RADAR_DEFENDER_CONFIG.review,
    });

    expect(result.findings.some((finding) => finding.finding.includes("Unsafe HTML"))).toBe(true);
  });

  it("detects permissive RLS policies", () => {
    const result = reviewArtifact({
      artifact: {
        kind: "sql-policy",
        name: "jobs_owner_policy",
        content: "create policy jobs_owner_policy on jobs using (true) with check (true);",
      },
      reviewConfig: DEFAULT_RADAR_DEFENDER_CONFIG.review,
    });

    expect(result.findings.some((finding) => finding.severity === "critical")).toBe(true);
  });

  it("flags route handlers missing auth, admin, or ownership signals", () => {
    const result = reviewArtifact({
      artifact: {
        kind: "route",
        name: "PUT /api/admin/jobs/[id]",
        content: `
          export async function PUT(request) {
            const body = await request.json();
            return Response.json({ ok: true, body });
          }
        `,
        metadata: {
          method: "PUT",
          routePath: "/api/admin/jobs/[id]",
        },
      },
      reviewConfig: DEFAULT_RADAR_DEFENDER_CONFIG.review,
    });

    expect(result.findings.some((finding) => finding.finding.includes("auth boundary"))).toBe(true);
    expect(
      result.findings.some((finding) => finding.finding.includes("Admin or support route")),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) =>
          finding.finding.includes("ownership") || finding.finding.includes("Resource-scoped"),
      ),
    ).toBe(true);
  });
});
