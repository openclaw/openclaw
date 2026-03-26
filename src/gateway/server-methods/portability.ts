import { logActivity } from "../../orchestration/activity-log-sqlite.js";
import * as PortabilityStore from "../../orchestration/portability-store-sqlite.js";
import type { PortabilityInclude } from "../../orchestration/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type PortabilityExportsListParams = { workspaceId?: string };
type PortabilityExportsCreateParams = {
  workspaceId: string;
  include: PortabilityInclude;
  exportedBy?: string;
};
type PortabilityExportsGetParams = { id: string };
type PortabilityImportsListParams = { workspaceId?: string };
type PortabilityImportsCreateParams = {
  workspaceId: string;
  sourceRef?: string;
  collisionStrategy?: string;
  importedBy?: string;
};
type PortabilityImportsGetParams = { id: string };

function storeErrorToShape(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return errorShape(ErrorCodes.UNAVAILABLE, msg);
}

export const portabilityHandlers: GatewayRequestHandlers = {
  "portability.exports.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as PortabilityExportsListParams;
      const exports = PortabilityStore.listPortabilityExports(p.workspaceId);
      respond(true, { exports });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "portability.exports.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as PortabilityExportsCreateParams;
      const exportRecord = PortabilityStore.createPortabilityExport({
        workspaceId: p.workspaceId,
        include: p.include,
        exportedBy: p.exportedBy,
      });
      logActivity({
        workspaceId: p.workspaceId,
        entityType: "portability_export",
        entityId: exportRecord.id,
        action: "created",
        details: { include: p.include },
      });
      respond(true, exportRecord);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "portability.exports.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as PortabilityExportsGetParams;
      const exportRecord = PortabilityStore.getPortabilityExport(p.id);
      if (!exportRecord) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Portability export not found"));
        return;
      }
      respond(true, exportRecord);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "portability.imports.list": async ({ params, respond }) => {
    try {
      const p = params as unknown as PortabilityImportsListParams;
      const imports = PortabilityStore.listPortabilityImports(p.workspaceId);
      respond(true, { imports });
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "portability.imports.create": async ({ params, respond }) => {
    try {
      const p = params as unknown as PortabilityImportsCreateParams;
      const importRecord = PortabilityStore.createPortabilityImport({
        workspaceId: p.workspaceId,
        sourceRef: p.sourceRef,
        collisionStrategy: p.collisionStrategy,
        importedBy: p.importedBy,
      });
      logActivity({
        workspaceId: p.workspaceId,
        entityType: "portability_import",
        entityId: importRecord.id,
        action: "created",
        details: { sourceRef: p.sourceRef },
      });
      respond(true, importRecord);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },

  "portability.imports.get": async ({ params, respond }) => {
    try {
      const p = params as unknown as PortabilityImportsGetParams;
      const importRecord = PortabilityStore.getPortabilityImport(p.id);
      if (!importRecord) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Portability import not found"));
        return;
      }
      respond(true, importRecord);
    } catch (err) {
      respond(false, undefined, storeErrorToShape(err));
    }
  },
};
