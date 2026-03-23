import * as TaskAttachments from "../../orchestration/task-attachments-sqlite.js";
import * as TaskDocuments from "../../orchestration/task-documents-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const taskDocumentsHandlers: GatewayRequestHandlers = {
  "tasks.documents.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as { taskId: string };
      const documents = TaskDocuments.listTaskDocuments(p.taskId);
      respond(true, { documents });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.documents.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as { id: string };
      const doc = TaskDocuments.getTaskDocument(p.id);
      if (!doc) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Document not found"));
        return;
      }
      respond(true, doc);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.documents.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as {
        taskId: string;
        title?: string;
        body?: string;
        format?: string;
        createdBy?: string;
      };
      const doc = TaskDocuments.createTaskDocument({
        taskId: p.taskId,
        title: p.title,
        body: p.body,
        format: p.format as "markdown" | "plain" | "html" | undefined,
        createdBy: p.createdBy,
      });
      respond(true, doc);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.documents.update": async ({ params, respond }) => {
    try {
      const p = params as unknown as {
        id: string;
        title?: string;
        body?: string;
        updatedBy?: string;
      };
      const doc = TaskDocuments.updateTaskDocument(p.id, {
        title: p.title,
        body: p.body,
        updatedBy: p.updatedBy,
      });
      respond(true, doc);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.documents.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as { id: string };
      TaskDocuments.deleteTaskDocument(p.id);
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  // ── Attachments ────────────────────────────────────────────────────────────

  "tasks.attachments.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as { taskId: string };
      const attachments = TaskAttachments.listTaskAttachments(p.taskId);
      respond(true, { attachments });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.attachments.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as {
        taskId: string;
        filename: string;
        mimeType?: string;
        sizeBytes?: number;
        storagePath: string;
        createdBy?: string;
      };
      const attachment = TaskAttachments.createTaskAttachment({
        taskId: p.taskId,
        filename: p.filename,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
        storagePath: p.storagePath,
        createdBy: p.createdBy,
      });
      respond(true, attachment);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "tasks.attachments.delete": async ({ params, respond }) => {
    try {
      const p = params as unknown as { id: string };
      TaskAttachments.deleteTaskAttachment(p.id);
      respond(true, { ok: true });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
