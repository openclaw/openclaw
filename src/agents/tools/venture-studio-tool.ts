import { Type } from "@sinclair/typebox";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { optionalStringEnum } from "../schema/typebox.js";
import {
  ToolInputError,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";

const VENTURE_ACTIONS = [
  "init",
  "add_finding",
  "list_findings",
  "plan_apps",
  "list_plans",
  "build_scaffold",
] as const;
const SOURCE_TYPES = ["web", "forum", "other"] as const;
const URGENCY_LEVELS = ["low", "medium", "high", "critical"] as const;
const STACK_OPTIONS = [
  "nextjs-node-postgres",
  "react-fastapi-postgres",
  "sveltekit-supabase",
] as const;

type VentureAction = (typeof VENTURE_ACTIONS)[number];
type SourceType = (typeof SOURCE_TYPES)[number];
type UrgencyLevel = (typeof URGENCY_LEVELS)[number];
type StackOption = (typeof STACK_OPTIONS)[number];

type ResearchFinding = {
  id: string;
  sourceType: SourceType;
  sourceUrl?: string;
  title: string;
  painPoint: string;
  targetCustomer: string;
  urgency: UrgencyLevel;
  willingnessToPay?: string;
  observedAt: string;
};

type AppPlan = {
  id: string;
  name: string;
  problem: string;
  users: string;
  monetization: string;
  billionDollarThesis: string;
  stack: StackOption;
  workflowPath: string;
  docPath: string;
  specPath: string;
  basedOnFindingIds: string[];
  createdAt: string;
};

type VentureStudioState = {
  version: 1;
  initializedAt: string;
  findings: ResearchFinding[];
  plans: AppPlan[];
};

const VentureStudioToolSchema = Type.Object({
  action: optionalStringEnum(VENTURE_ACTIONS),
  path: Type.Optional(Type.String()),
  outputDir: Type.Optional(Type.String()),
  sourceType: optionalStringEnum(SOURCE_TYPES),
  sourceUrl: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  painPoint: Type.Optional(Type.String()),
  targetCustomer: Type.Optional(Type.String()),
  urgency: optionalStringEnum(URGENCY_LEVELS),
  willingnessToPay: Type.Optional(Type.String()),
  appName: Type.Optional(Type.String()),
  appCount: Type.Optional(Type.Number({ minimum: 1, maximum: 10 })),
  monetization: Type.Optional(Type.String()),
  thesis: Type.Optional(Type.String()),
  findingIds: Type.Optional(Type.Array(Type.String())),
  planId: Type.Optional(Type.String()),
  stack: optionalStringEnum(STACK_OPTIONS),
  appRootDir: Type.Optional(Type.String()),
});

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 60);
}

function isWithinWorkspace(candidatePath: string, workspaceDir: string) {
  const rel = path.relative(workspaceDir, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveWorkspacePath(params: {
  workspaceDir: string;
  rawPath?: string;
  fallback: string;
}) {
  const workspaceDir = path.resolve(params.workspaceDir);
  const targetPath = params.rawPath?.trim()
    ? path.resolve(workspaceDir, params.rawPath)
    : path.join(workspaceDir, params.fallback);
  if (!isWithinWorkspace(targetPath, workspaceDir)) {
    throw new ToolInputError("path must stay within the workspace directory");
  }
  return targetPath;
}

function urgencyWeight(urgency: UrgencyLevel): number {
  if (urgency === "critical") {
    return 4;
  }
  if (urgency === "high") {
    return 3;
  }
  if (urgency === "medium") {
    return 2;
  }
  return 1;
}

function sortFindingsByOpportunity(findings: ResearchFinding[]): ResearchFinding[] {
  return [...findings].toSorted((a, b) => urgencyWeight(b.urgency) - urgencyWeight(a.urgency));
}

function defaultState(): VentureStudioState {
  return {
    version: 1,
    initializedAt: new Date().toISOString(),
    findings: [],
    plans: [],
  };
}

async function readState(statePath: string): Promise<VentureStudioState | null> {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as VentureStudioState;
  } catch (error) {
    const anyErr = error as { code?: string };
    if (anyErr.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeState(statePath: string, state: VentureStudioState): Promise<void> {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function nextSequenceId(prefix: string, existingIds: string[]): string {
  const used = new Set(existingIds);
  for (let i = 1; i <= 100_000; i += 1) {
    const candidate = `${prefix}-${i}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${prefix}-${Date.now().toString(36)}`;
}

async function writePlanArtifacts(params: {
  outputDir: string;
  planId: string;
  appName: string;
  problem: string;
  users: string;
  monetization: string;
  thesis: string;
  stack: StackOption;
  findings: ResearchFinding[];
}): Promise<{ docPath: string; workflowPath: string; specPath: string }> {
  const planDir = path.join(params.outputDir, params.planId);
  await fs.mkdir(planDir, { recursive: true });

  const docPath = path.join(planDir, "PLAN.md");
  const workflowPath = path.join(planDir, "workflow.json");
  const specPath = path.join(planDir, "APP_SPEC.json");

  const findingsSection = params.findings
    .map(
      (finding) =>
        `- ${finding.title} (${finding.sourceType}${finding.sourceUrl ? `: ${finding.sourceUrl}` : ""}) — ${finding.painPoint}`,
    )
    .join("\n");

  const planDoc = `# ${params.appName}\n\n## Problem\n${params.problem}\n\n## Target users\n${params.users}\n\n## Monetization\n${params.monetization}\n\n## Billion-dollar thesis\n${params.thesis}\n\n## Recommended stack\n${params.stack}\n\n## Evidence from research\n${findingsSection || "- No findings attached."}\n\n## Build workflow\n1. Validate demand with 10 customer interviews from identified segment.\n2. Build MVP full-stack app with auth, billing, and analytics.\n3. Launch paid pilot with design partners.\n4. Iterate weekly from support/usage data.\n5. Expand distribution via integrations and channel partners.\n`;

  const workflow = {
    stages: [
      { id: "research", goal: "Verify problem urgency and willingness to pay" },
      { id: "product", goal: "Define MVP scope and technical architecture" },
      { id: "build", goal: "Ship production-ready full-stack MVP" },
      { id: "go_to_market", goal: "Acquire first paying customers" },
      { id: "scale", goal: "Expand to enterprise and adjacent markets" },
    ],
    generatedAt: new Date().toISOString(),
  };

  const spec = {
    appName: params.appName,
    problem: params.problem,
    users: params.users,
    monetization: params.monetization,
    stack: params.stack,
    coreFeatures: [
      "authentication",
      "team workspace",
      "automation workflows",
      "billing subscriptions",
      "usage analytics dashboard",
    ],
    nonFunctional: ["security", "auditability", "multi-tenant readiness", "cost controls"],
    generatedAt: new Date().toISOString(),
  };

  await fs.writeFile(docPath, planDoc, "utf-8");
  await fs.writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, "utf-8");
  await fs.writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`, "utf-8");

  return { docPath, workflowPath, specPath };
}

async function writeDiscussionDoc(outputDir: string, newPlans: AppPlan[]): Promise<string> {
  const discussionPath = path.join(outputDir, "DISCUSSION.md");
  const lines = [
    "# Venture Studio Discussion",
    "",
    "## Goal",
    "Identify painful, recurring, high-value problems and turn them into monetized full-stack app opportunities.",
    "",
    "## Candidate plans",
    ...newPlans.map(
      (plan) =>
        `- **${plan.name}**: solves "${plan.problem}" for ${plan.users}. Revenue: ${plan.monetization}`,
    ),
    "",
    "## Agent roundtable",
    "- Strategist: Is this pain frequent enough to justify an always-on product?",
    "- Product Lead: What is the narrow MVP wedge that can be shipped in under 8 weeks?",
    "- Designer: Which workflow screens remove the biggest friction first?",
    "- DevOps Architect: Which stack minimizes time-to-production and ops risk?",
    "- Builder: What implementation milestones de-risk integration and billing early?",
    "- Auditor: What security/compliance controls are mandatory before paid rollout?",
    "",
    "## Decision checklist",
    "- Is the pain urgent and frequent?",
    "- Can customers justify paying quickly?",
    "- Can the first version be shipped in <8 weeks?",
    "- Does the wedge support expansion into a large market?",
    "",
  ];
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(discussionPath, lines.join("\n"), "utf-8");
  return discussionPath;
}

async function buildScaffold(params: {
  workspaceDir: string;
  appRootDirRaw?: string;
  plan: AppPlan;
}): Promise<{ scaffoldRoot: string; createdFiles: string[] }> {
  const appRootDir = resolveWorkspacePath({
    workspaceDir: params.workspaceDir,
    rawPath: params.appRootDirRaw,
    fallback: "venture-studio/apps",
  });
  const scaffoldRoot = path.join(appRootDir, params.plan.id);
  const backendDir = path.join(scaffoldRoot, "backend");
  const frontendDir = path.join(scaffoldRoot, "frontend");
  const dbDir = path.join(scaffoldRoot, "db");

  await fs.mkdir(backendDir, { recursive: true });
  await fs.mkdir(frontendDir, { recursive: true });
  await fs.mkdir(dbDir, { recursive: true });

  const isNodeBackend = params.plan.stack !== "react-fastapi-postgres";
  const backendDockerfile = isNodeBackend
    ? 'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json package.json\nRUN npm install\nCOPY . .\nEXPOSE 8080\nCMD ["npm","run","dev"]\n'
    : 'FROM python:3.12-slim\nWORKDIR /app\nCOPY requirements.txt requirements.txt\nRUN pip install --no-cache-dir -r requirements.txt\nCOPY . .\nEXPOSE 8080\nCMD ["uvicorn","main:app","--host","0.0.0.0","--port","8080"]\n';

  const backendPackageJson = JSON.stringify(
    {
      name: "backend",
      private: true,
      type: "module",
      scripts: {
        dev: "node server.js",
      },
      dependencies: {
        cors: "^2.8.5",
        express: "^4.21.2",
        pg: "^8.13.1",
      },
    },
    null,
    2,
  );

  const frontendPackageJsonByStack: Record<StackOption, string> = {
    "nextjs-node-postgres": JSON.stringify(
      {
        name: "frontend",
        private: true,
        scripts: {
          dev: "next dev -p 3000",
          build: "next build",
          start: "next start -p 3000",
        },
        dependencies: {
          next: "^15.0.4",
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
      },
      null,
      2,
    ),
    "react-fastapi-postgres": JSON.stringify(
      {
        name: "frontend",
        private: true,
        scripts: {
          dev: "vite --host 0.0.0.0 --port 3000",
          build: "vite build",
          preview: "vite preview --host 0.0.0.0 --port 3000",
        },
        dependencies: {
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          vite: "^5.4.11",
          "@vitejs/plugin-react": "^4.3.3",
        },
      },
      null,
      2,
    ),
    "sveltekit-supabase": JSON.stringify(
      {
        name: "frontend",
        private: true,
        scripts: {
          dev: "vite dev --host 0.0.0.0 --port 3000",
          build: "vite build",
          preview: "vite preview --host 0.0.0.0 --port 3000",
        },
        dependencies: {
          "@sveltejs/kit": "^2.8.3",
          "@supabase/supabase-js": "^2.47.4",
          svelte: "^5.2.7",
        },
        devDependencies: {
          vite: "^5.4.11",
        },
      },
      null,
      2,
    ),
  };

  const frontendEntryByStack: Record<StackOption, { file: string; content: string }> = {
    "nextjs-node-postgres": {
      file: "pages/index.js",
      content:
        "export default function Home() {\n  return <main><h1>Venture Scaffold</h1><p>Replace this page with your product UI.</p></main>;\n}\n",
    },
    "react-fastapi-postgres": {
      file: "src/main.jsx",
      content:
        "import React from 'react';\nimport { createRoot } from 'react-dom/client';\nfunction App() {\n  return <main><h1>Venture Scaffold</h1><p>Replace with your product UI.</p></main>;\n}\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    },
    "sveltekit-supabase": {
      file: "src/routes/+page.svelte",
      content:
        "<main><h1>Venture Scaffold</h1><p>Replace this page with your product UI.</p></main>\n",
    },
  };

  const frontendAuxFilesByStack: Record<StackOption, Array<{ path: string; content: string }>> = {
    "nextjs-node-postgres": [],
    "react-fastapi-postgres": [
      {
        path: path.join(frontendDir, "index.html"),
        content:
          "<!doctype html>\n<html><body><div id='root'></div><script type='module' src='/src/main.jsx'></script></body></html>\n",
      },
      {
        path: path.join(frontendDir, "vite.config.js"),
        content:
          "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n",
      },
    ],
    "sveltekit-supabase": [
      {
        path: path.join(frontendDir, "vite.config.js"),
        content: "import { defineConfig } from 'vite';\nexport default defineConfig({});\n",
      },
      {
        path: path.join(frontendDir, "svelte.config.js"),
        content: "export default { };\n",
      },
    ],
  };

  const files: Array<{ path: string; content: string }> = [
    {
      path: path.join(scaffoldRoot, "README.md"),
      content: `# ${params.plan.name}\n\nProblem: ${params.plan.problem}\nUsers: ${params.plan.users}\nMonetization: ${params.plan.monetization}\nStack: ${params.plan.stack}\n\nThis scaffold was generated from venture_studio plan ${params.plan.id}.\n`,
    },
    {
      path: path.join(scaffoldRoot, "docker-compose.yml"),
      content:
        'version: "3.9"\nservices:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: app\n      POSTGRES_DB: app\n    ports:\n      - "5432:5432"\n    volumes:\n      - ./db/init.sql:/docker-entrypoint-initdb.d/init.sql\n  backend:\n    build: ./backend\n    ports:\n      - "8080:8080"\n    depends_on:\n      - db\n  frontend:\n    build: ./frontend\n    ports:\n      - "3000:3000"\n    depends_on:\n      - backend\n',
    },
    {
      path: path.join(dbDir, "init.sql"),
      content:
        "CREATE TABLE IF NOT EXISTS accounts (\n  id SERIAL PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ DEFAULT NOW()\n);\n",
    },
    {
      path: path.join(backendDir, "Dockerfile"),
      content: backendDockerfile,
    },
    {
      path: path.join(backendDir, "package.json"),
      content: `${backendPackageJson}\n`,
    },
    {
      path: path.join(backendDir, "server.js"),
      content:
        "import express from 'express';\nimport cors from 'cors';\nimport pkg from 'pg';\nconst { Pool } = pkg;\nconst app = express();\nconst pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://app:app@db:5432/app' });\napp.use(cors());\napp.get('/health', async (_req, res) => {\n  const client = await pool.connect();\n  try { await client.query('select 1'); res.json({ ok: true }); }\n  finally { client.release(); }\n});\napp.listen(8080, () => console.log('backend on :8080'));\n",
    },
    {
      path: path.join(backendDir, "requirements.txt"),
      content: "fastapi==0.115.5\nuvicorn==0.32.1\npsycopg[binary]==3.2.3\n",
    },
    {
      path: path.join(backendDir, "main.py"),
      content:
        "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/health')\ndef health():\n    return {'ok': True}\n",
    },
    {
      path: path.join(frontendDir, "Dockerfile"),
      content:
        'FROM node:22-alpine\nWORKDIR /app\nCOPY package.json package.json\nRUN npm install\nCOPY . .\nEXPOSE 3000\nCMD ["npm","run","dev"]\n',
    },
    {
      path: path.join(frontendDir, "package.json"),
      content: `${frontendPackageJsonByStack[params.plan.stack]}\n`,
    },
    {
      path: path.join(frontendDir, frontendEntryByStack[params.plan.stack].file),
      content: frontendEntryByStack[params.plan.stack].content,
    },
    ...frontendAuxFilesByStack[params.plan.stack],
    {
      path: path.join(scaffoldRoot, "DEPENDENCIES.md"),
      content:
        "# Dependency setup\n\n- Backend dependencies are declared in `backend/package.json` (Node) and `backend/requirements.txt` (Python fallback for FastAPI stack).\n- Frontend dependencies are declared in `frontend/package.json` according to the selected stack.\n- Start services with: `docker compose up --build`\n- Windows PowerShell helper: `./scripts/dev.ps1`\n- Windows CMD helper: `scripts\\dev.cmd`\n",
    },
    {
      path: path.join(scaffoldRoot, "scripts", "dev.ps1"),
      content:
        "$ErrorActionPreference = 'Stop'\nSet-Location -Path $PSScriptRoot\nSet-Location -Path ..\ndocker compose up --build\n",
    },
    {
      path: path.join(scaffoldRoot, "scripts", "dev.cmd"),
      content: "@echo off\ncd /d %~dp0\ncd ..\ndocker compose up --build\n",
    },
  ];

  const filteredFiles =
    params.plan.stack === "react-fastapi-postgres"
      ? files.filter(
          (file) =>
            !file.path.endsWith(path.join("backend", "package.json")) &&
            !file.path.endsWith(path.join("backend", "server.js")),
        )
      : files.filter(
          (file) =>
            !file.path.endsWith(path.join("backend", "requirements.txt")) &&
            !file.path.endsWith(path.join("backend", "main.py")),
        );

  for (const file of filteredFiles) {
    await fs.mkdir(path.dirname(file.path), { recursive: true });
    await fs.writeFile(file.path, file.content, "utf-8");
  }

  return { scaffoldRoot, createdFiles: filteredFiles.map((file) => file.path) };
}

export function createVentureStudioTool(options: { workspaceDir: string }): AnyAgentTool {
  return {
    label: "Venture Studio",
    name: "venture_studio",
    description:
      "Track web/forum pain-point research and generate monetized app plans, workflows, and build scaffolds.",
    parameters: VentureStudioToolSchema,
    execute: async (_callId, input) => {
      const params = (input ?? {}) as Record<string, unknown>;
      const action = (readStringParam(params, "action") ?? "list_findings") as VentureAction;
      const statePath = resolveWorkspacePath({
        workspaceDir: options.workspaceDir,
        rawPath: readStringParam(params, "path"),
        fallback: "venture-studio/state.json",
      });

      if (action === "init") {
        const state = defaultState();
        await writeState(statePath, state);
        return jsonResult({ action, statePath, state });
      }

      const current = await readState(statePath);
      if (!current) {
        throw new ToolInputError(
          `venture studio state not found at ${statePath}. Run action=init first.`,
        );
      }

      if (action === "add_finding") {
        const title = readStringParam(params, "title", { required: true });
        const painPoint = readStringParam(params, "painPoint", { required: true });
        const targetCustomer = readStringParam(params, "targetCustomer", { required: true });
        const sourceType = (readStringParam(params, "sourceType") ?? "other") as SourceType;
        const duplicate = current.findings.find(
          (finding) => finding.title === title && finding.targetCustomer === targetCustomer,
        );
        if (duplicate) {
          return jsonResult({
            action,
            statePath,
            deduped: true,
            finding: duplicate,
            totalFindings: current.findings.length,
          });
        }

        const finding: ResearchFinding = {
          id: nextSequenceId(
            "finding",
            current.findings.map((entry) => entry.id),
          ),
          sourceType,
          sourceUrl: readStringParam(params, "sourceUrl"),
          title,
          painPoint,
          targetCustomer,
          urgency: (readStringParam(params, "urgency") ?? "medium") as UrgencyLevel,
          willingnessToPay: readStringParam(params, "willingnessToPay"),
          observedAt: new Date().toISOString(),
        };
        const next: VentureStudioState = {
          ...current,
          findings: [...current.findings, finding],
        };
        await writeState(statePath, next);
        return jsonResult({ action, statePath, finding, totalFindings: next.findings.length });
      }

      if (action === "list_findings") {
        return jsonResult({ action, statePath, findings: current.findings });
      }

      if (action === "plan_apps") {
        const appCount = readNumberParam(params, "appCount", { integer: true }) ?? 3;
        const requestedFindingIds = readStringArrayParam(params, "findingIds") ?? [];
        const selectedFindings =
          requestedFindingIds.length > 0
            ? current.findings.filter((finding) => requestedFindingIds.includes(finding.id))
            : sortFindingsByOpportunity(current.findings).slice(0, appCount);
        if (selectedFindings.length === 0) {
          throw new ToolInputError("No findings available for planning. Add findings first.");
        }

        const outputDir = resolveWorkspacePath({
          workspaceDir: options.workspaceDir,
          rawPath: readStringParam(params, "outputDir"),
          fallback: "venture-studio/plans",
        });
        const stack = (readStringParam(params, "stack") ?? "nextjs-node-postgres") as StackOption;

        const newPlans: AppPlan[] = [];
        for (const finding of selectedFindings.slice(0, appCount)) {
          const appName =
            readStringParam(params, "appName") ??
            `${finding.targetCustomer} ${finding.title}`.replace(/\s+/g, " ").trim();
          const existingIds = [...current.plans, ...newPlans].map((plan) => plan.id);
          const planIdBase = toSlug(appName) || "app-plan";
          const planId = nextSequenceId(planIdBase, existingIds);
          const monetization =
            readStringParam(params, "monetization") ??
            finding.willingnessToPay ??
            "Subscription tiers with usage-based enterprise add-ons";
          const thesis =
            readStringParam(params, "thesis") ??
            `Own a mission-critical workflow for ${finding.targetCustomer} where urgency is ${finding.urgency}, then compound growth through integrations, data network effects, and enterprise expansion.`;

          const artifacts = await writePlanArtifacts({
            outputDir,
            planId,
            appName,
            problem: finding.painPoint,
            users: finding.targetCustomer,
            monetization,
            thesis,
            stack,
            findings: [finding],
          });

          newPlans.push({
            id: planId,
            name: appName,
            problem: finding.painPoint,
            users: finding.targetCustomer,
            monetization,
            billionDollarThesis: thesis,
            stack,
            workflowPath: artifacts.workflowPath,
            docPath: artifacts.docPath,
            specPath: artifacts.specPath,
            basedOnFindingIds: [finding.id],
            createdAt: new Date().toISOString(),
          });
        }

        const discussionPath = await writeDiscussionDoc(outputDir, newPlans);
        const next: VentureStudioState = {
          ...current,
          plans: [...current.plans, ...newPlans],
        };
        await writeState(statePath, next);
        return jsonResult({
          action,
          statePath,
          discussionPath,
          generatedPlans: newPlans,
          totalPlans: next.plans.length,
        });
      }

      if (action === "list_plans") {
        return jsonResult({ action, statePath, plans: current.plans });
      }

      if (action === "build_scaffold") {
        const planId = readStringParam(params, "planId", { required: true });
        const plan = current.plans.find((entry) => entry.id === planId);
        if (!plan) {
          throw new ToolInputError(`Unknown planId: ${planId}`);
        }
        const scaffold = await buildScaffold({
          workspaceDir: options.workspaceDir,
          appRootDirRaw: readStringParam(params, "appRootDir"),
          plan,
        });
        return jsonResult({ action, planId, ...scaffold });
      }

      throw new ToolInputError("Unknown action.");
    },
  };
}
