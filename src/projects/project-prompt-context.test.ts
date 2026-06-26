// Tests for bounded project prompt context rendering.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { diagnoseProjectDocumentSummary } from "./project-document-summary.js";
import { buildProjectPromptContextFromRecord } from "./project-prompt-context.js";
import type { ProjectForSession } from "./project-store.js";
import type { ProjectDocumentRecord } from "./project-types.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("project prompt context", () => {
  it("renders project, chat, summary, instructions, decisions, and documents", () => {
    const context = buildProjectPromptContextFromRecord({
      project: {
        projectId: "proj_1",
        name: "OpenClaw Workspaces",
        description: "Project workspace MVP",
        status: "active",
        createdAtMs: 1,
        updatedAtMs: 2,
        sortOrder: 0,
      },
      chat: {
        projectId: "proj_1",
        sessionKey: "agent:main:main",
        title: "Backend",
        role: "implementation",
        status: "active",
        sortOrder: 0,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      role: {
        projectId: "proj_1",
        roleKey: "implementation",
        name: "Builder",
        description: "Implement verified changes.",
        instructions: "Usa pasos pequenos y pruebas enfocadas.",
        status: "active",
        sortOrder: 0,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      context: {
        projectId: "proj_1",
        summary: "Build the shared project model.",
        instructions: "Keep session transcripts intact.",
        decisions: ["Use SQLite for project metadata"],
        documents: ["Arquitectura Real OpenClaw 2026.6.10.md"],
        updatedAtMs: 3,
      },
      documents: [
        {
          projectId: "proj_1",
          documentId: "doc_1",
          title: "Architecture inventory",
          uri: "/vault/MejorasOpenClaw/Arquitectura Real OpenClaw 2026.6.10.md",
          kind: "obsidian",
          notes: "Primary map for sessions, storage, and gateway methods.",
          includeInContext: true,
          status: "active",
          sortOrder: 0,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
      ],
    });

    expect(context).toContain("<project_context>");
    expect(context).toContain("Proyecto: OpenClaw Workspaces");
    expect(context).toContain("Chat de proyecto: Backend");
    expect(context).toContain("Rol del chat: Builder");
    expect(context).toContain("Descripcion del rol: Implement verified changes.");
    expect(context).toContain("Instrucciones del rol:\nUsa pasos pequenos y pruebas enfocadas.");
    expect(context).toContain("Resumen:\nBuild the shared project model.");
    expect(context).toContain("- Use SQLite for project metadata");
    expect(context).toContain(
      "- Architecture inventory (tipo: obsidian, uri: /vault/MejorasOpenClaw/Arquitectura Real OpenClaw 2026.6.10.md)",
    );
    expect(context).toContain("Notas: Primary map for sessions, storage, and gateway methods.");
    expect(context).toContain("- Arquitectura Real OpenClaw 2026.6.10.md");
    expect(context).toContain("</project_context>");
  });

  it("returns undefined when no project is active for the session", () => {
    expect(buildProjectPromptContextFromRecord(null)).toBeUndefined();
  });

  it("includes active documents selected by role or chat metadata", () => {
    const context = buildProjectPromptContextFromRecord({
      project: {
        projectId: "proj_1",
        name: "OpenClaw Workspaces",
        status: "active",
        createdAtMs: 1,
        updatedAtMs: 2,
        sortOrder: 0,
      },
      chat: {
        projectId: "proj_1",
        sessionKey: "agent:main:main",
        status: "active",
        sortOrder: 0,
        createdAtMs: 1,
        updatedAtMs: 2,
        metadata: { projectDocumentIds: ["doc_chat"] },
      },
      role: {
        projectId: "proj_1",
        roleKey: "implementation",
        name: "Builder",
        status: "active",
        sortOrder: 0,
        createdAtMs: 1,
        updatedAtMs: 2,
        metadata: { projectDocumentIds: ["doc_role"] },
      },
      documents: [
        {
          projectId: "proj_1",
          documentId: "doc_global",
          title: "Global spec",
          includeInContext: true,
          status: "active",
          sortOrder: 0,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        {
          projectId: "proj_1",
          documentId: "doc_role",
          title: "Role runbook",
          includeInContext: false,
          status: "active",
          sortOrder: 1,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
        {
          projectId: "proj_1",
          documentId: "doc_chat",
          title: "Chat brief",
          includeInContext: false,
          status: "active",
          sortOrder: 2,
          createdAtMs: 1,
          updatedAtMs: 2,
        },
      ],
    });

    expect(context).toContain("- Global spec");
    expect(context).toContain("- Role runbook");
    expect(context).toContain("- Chat brief");
  });

  it("adds bounded automatic summaries for long local text documents", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-project-doc-summary-"));
    const filePath = path.join(dir, "Long Spec.md");
    fs.writeFileSync(
      filePath,
      [
        "# Architecture",
        "This specification explains the project architecture and the operational constraints.",
        "It contains enough detail to exceed the automatic summary threshold.",
        "## Decisions",
        "Use bounded local summaries before injecting project document context.",
        "## Risks",
        "Document contents must be treated as untrusted context.",
        "Operational notes ".repeat(160),
      ].join("\n\n"),
      "utf8",
    );

    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-doc-summary-state-" },
      async () => {
        const context = buildProjectPromptContextFromRecord({
          project: {
            projectId: "proj_1",
            name: "OpenClaw Workspaces",
            status: "active",
            createdAtMs: 1,
            updatedAtMs: 2,
            sortOrder: 0,
          },
          chat: {
            projectId: "proj_1",
            sessionKey: "agent:main:main",
            status: "active",
            sortOrder: 0,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
          documents: [
            {
              projectId: "proj_1",
              documentId: "doc_long",
              title: "Long Spec",
              uri: filePath,
              kind: "obsidian",
              includeInContext: true,
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        });

        expect(context).toContain("Resumen automatico local");
        expect(context).toContain("Encabezados: Architecture | Decisions | Risks");
        expect(context).toContain("contenido no confiable");
      },
    );
  });

  it("invalidates cached document summaries when mtime or size changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-project-doc-summary-cache-"));
    const filePath = path.join(dir, "Long Spec.md");
    const writeLongFile = (heading: string, mtimeMs: number) => {
      fs.writeFileSync(
        filePath,
        [
          `# ${heading}`,
          "This specification is intentionally long enough to be summarized.",
          "## Details",
          "Project notes ".repeat(220),
        ].join("\n\n"),
        "utf8",
      );
      const mtime = new Date(mtimeMs);
      fs.utimesSync(filePath, mtime, mtime);
    };
    const document = (): ProjectDocumentRecord => ({
      projectId: "proj_1",
      documentId: "doc_long",
      title: "Long Spec",
      uri: filePath,
      includeInContext: true,
      status: "active",
      sortOrder: 0,
      createdAtMs: 1,
      updatedAtMs: 2,
    });
    const record = (): ProjectForSession => ({
      project: {
        projectId: "proj_1",
        name: "OpenClaw Workspaces",
        status: "active",
        createdAtMs: 1,
        updatedAtMs: 2,
        sortOrder: 0,
      },
      chat: {
        projectId: "proj_1",
        sessionKey: "agent:main:main",
        status: "active",
        sortOrder: 0,
        createdAtMs: 1,
        updatedAtMs: 2,
      },
      documents: [document()],
    });

    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-doc-summary-cache-state-" },
      async () => {
        const database = openOpenClawStateDatabase();
        database.db
          .prepare(
            `
              INSERT INTO projects (
                project_id,
                name,
                status,
                created_at_ms,
                updated_at_ms
              )
              VALUES (?, ?, ?, ?, ?)
            `,
          )
          .run("proj_1", "OpenClaw Workspaces", "active", 1, 2);
        database.db
          .prepare(
            `
              INSERT INTO project_documents (
                project_id,
                document_id,
                title,
                uri,
                include_in_context,
                status,
                sort_order,
                created_at_ms,
                updated_at_ms
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
          )
          .run("proj_1", "doc_long", "Long Spec", filePath, 1, "active", 0, 1, 2);

        writeLongFile("Original Architecture", 1_800_000_000_000);
        const originalContext = buildProjectPromptContextFromRecord(record());
        expect(originalContext).toContain("Original Architecture");
        expect(diagnoseProjectDocumentSummary(document())).toMatchObject({
          status: "summarized",
          cache: "hit",
          injectsSummary: true,
        });
        expect(
          database.db
            .prepare("SELECT summary FROM project_document_summary_cache WHERE document_id = ?")
            .get("doc_long"),
        ).toMatchObject({ summary: expect.stringContaining("Original Architecture") });

        writeLongFile("Updated Architecture", 1_800_000_010_000);
        expect(diagnoseProjectDocumentSummary(document())).toMatchObject({
          status: "eligible",
          cache: "stale",
          injectsSummary: true,
        });
        const updatedContext = buildProjectPromptContextFromRecord(record());
        expect(updatedContext).toContain("Updated Architecture");
        expect(updatedContext).not.toContain("Original Architecture | Details");
        expect(diagnoseProjectDocumentSummary(document())).toMatchObject({
          status: "summarized",
          cache: "hit",
          injectsSummary: true,
        });
        expect(
          database.db
            .prepare("SELECT summary FROM project_document_summary_cache WHERE document_id = ?")
            .get("doc_long"),
        ).toMatchObject({ summary: expect.stringContaining("Updated Architecture") });
      },
    );
  });

  it("adds bounded automatic summaries for extracted PDF and DOCX documents", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-project-doc-binary-summary-"));
    const pdfPath = path.join(dir, "Long Spec.pdf");
    const docxPath = path.join(dir, "Long Spec.docx");
    fs.writeFileSync(
      pdfPath,
      createMinimalPdf(
        [
          "PDF Architecture",
          "This PDF specification explains the project architecture and extraction constraints.",
          "Operational PDF notes ".repeat(170),
        ].join(" "),
      ),
    );
    fs.writeFileSync(
      docxPath,
      await createMinimalDocx(
        [
          "DOCX Architecture",
          "This DOCX specification explains the project architecture and extraction constraints.",
          "Operational DOCX notes ".repeat(170),
        ].join(" "),
      ),
    );

    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-project-doc-binary-summary-state-" },
      async () => {
        const context = buildProjectPromptContextFromRecord({
          project: {
            projectId: "proj_1",
            name: "OpenClaw Workspaces",
            status: "active",
            createdAtMs: 1,
            updatedAtMs: 2,
            sortOrder: 0,
          },
          chat: {
            projectId: "proj_1",
            sessionKey: "agent:main:main",
            status: "active",
            sortOrder: 0,
            createdAtMs: 1,
            updatedAtMs: 2,
          },
          documents: [
            {
              projectId: "proj_1",
              documentId: "doc_pdf",
              title: "PDF Spec",
              uri: pdfPath,
              includeInContext: true,
              status: "active",
              sortOrder: 0,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
            {
              projectId: "proj_1",
              documentId: "doc_docx",
              title: "DOCX Spec",
              uri: docxPath,
              includeInContext: true,
              status: "active",
              sortOrder: 1,
              createdAtMs: 1,
              updatedAtMs: 2,
            },
          ],
        });

        expect(context).toContain("PDF extraido");
        expect(context).toContain("PDF Architecture");
        expect(context).toContain("DOCX extraido");
        expect(context).toContain("DOCX Architecture");
      },
    );
  });

  it("diagnoses PDF and DOCX project documents as extractable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-project-doc-binary-diagnostic-"));
    const pdfPath = path.join(dir, "Binary Spec.pdf");
    const docxPath = path.join(dir, "Binary Spec.docx");
    fs.writeFileSync(pdfPath, createMinimalPdf("Short PDF text"));
    fs.writeFileSync(docxPath, Buffer.from("placeholder"));
    const baseDocument = {
      projectId: "proj_1",
      documentId: "doc_pdf",
      title: "Binary Spec",
      includeInContext: true,
      status: "active",
      sortOrder: 0,
      createdAtMs: 1,
      updatedAtMs: 2,
    } as const;

    expect(
      diagnoseProjectDocumentSummary({
        ...baseDocument,
        uri: pdfPath,
      }),
    ).toMatchObject({
      status: "eligible",
      extension: ".pdf",
      injectsSummary: true,
    });
    expect(
      diagnoseProjectDocumentSummary({
        ...baseDocument,
        documentId: "doc_docx",
        uri: docxPath,
      }),
    ).toMatchObject({
      status: "eligible",
      extension: ".docx",
      injectsSummary: true,
    });
  });
});

function createMinimalPdf(text: string): Buffer {
  const safeText = text.replace(/[()\\]/gu, " ");
  const objects: string[] = [];
  const object = (id: number, value: string) => {
    objects[id] = `${id} 0 obj\n${value}\nendobj\n`;
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  );
  object(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const stream = `BT /F1 12 Tf 72 720 Td (${safeText}) Tj ET`;
  object(5, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let id = 1; id <= 5; id += 1) {
    offsets[id] = pdf.length;
    pdf += objects[id];
  }
  const xref = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let id = 1; id <= 5; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

async function createMinimalDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
      "<w:body>",
      `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`,
      "</w:body>",
      "</w:document>",
    ].join(""),
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
