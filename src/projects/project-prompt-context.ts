import { summarizeProjectDocument } from "./project-document-summary.js";
// Builds bounded project workspace context for agent prompts.
import { getActiveProjectForSession } from "./project-store.js";
import type { ProjectForSession } from "./project-store.js";
import { projectDocumentIdsFromMetadata } from "./project-types.js";

const PROJECT_PROMPT_CONTEXT_MAX_CHARS = 8_000;

function nonEmptyLines(values: readonly (string | undefined)[]): string[] {
  return values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
}

function bulletList(title: string, values: readonly string[]): string | undefined {
  const lines = values.map((value) => value.trim()).filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  return `${title}:\n${lines.map((value) => `- ${value}`).join("\n")}`;
}

function projectDocumentList(record: ProjectForSession): string | undefined {
  const documents = record.documents ?? [];
  if (documents.length === 0) {
    return undefined;
  }
  const selectedDocumentIds = new Set([
    ...projectDocumentIdsFromMetadata(record.role?.metadata),
    ...projectDocumentIdsFromMetadata(record.chat.metadata),
  ]);
  const seenDocumentIds = new Set<string>();
  const lines = documents
    .filter((document) => {
      if (document.status !== "active") {
        return false;
      }
      return document.includeInContext || selectedDocumentIds.has(document.documentId);
    })
    .filter((document) => {
      if (seenDocumentIds.has(document.documentId)) {
        return false;
      }
      seenDocumentIds.add(document.documentId);
      return true;
    })
    .map((document) => {
      const title = document.title.trim();
      const suffixes = nonEmptyLines([
        document.kind ? `tipo: ${document.kind}` : undefined,
        document.uri ? `uri: ${document.uri}` : undefined,
      ]);
      const heading = suffixes.length > 0 ? `${title} (${suffixes.join(", ")})` : title;
      const details = nonEmptyLines([
        document.notes ? `Notas: ${document.notes}` : undefined,
        summarizeProjectDocument(document),
      ]);
      return details.length > 0 ? `- ${heading}\n  ${details.join("\n  ")}` : `- ${heading}`;
    });
  return lines.length > 0 ? `Documentos de proyecto:\n${lines.join("\n")}` : undefined;
}

function roleGuidance(role: string | undefined): string | undefined {
  const normalized = role?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["implementation", "implementacion", "build"].includes(normalized)) {
    return [
      "Enfoque del rol:",
      "- Prioriza cambios concretos de codigo, arquitectura incremental y compatibilidad.",
      "- Propone verificaciones y pruebas junto a cada cambio relevante.",
      "- Evita redisenos amplios salvo que desbloqueen el objetivo del proyecto.",
    ].join("\n");
  }
  if (["research", "investigacion"].includes(normalized)) {
    return [
      "Enfoque del rol:",
      "- Prioriza exploracion, opciones, riesgos, fuentes y preguntas abiertas.",
      "- Separa hechos confirmados de inferencias y supuestos.",
      "- Resume hallazgos accionables para otros chats del proyecto.",
    ].join("\n");
  }
  if (["review", "qa", "quality"].includes(normalized)) {
    return [
      "Enfoque del rol:",
      "- Prioriza bugs, regresiones, riesgos, casos borde y pruebas faltantes.",
      "- Ordena hallazgos por severidad e impacto practico.",
      "- Evita reescrituras cosmeticas que no reduzcan riesgo.",
    ].join("\n");
  }
  if (["planning", "product", "strategy", "planificacion"].includes(normalized)) {
    return [
      "Enfoque del rol:",
      "- Prioriza alcance, decisiones, tradeoffs, secuencia de trabajo y criterios de exito.",
      "- Mantiene claridad entre objetivos, pendientes, riesgos y proximas acciones.",
      "- Ayuda a convertir conversaciones del proyecto en planes ejecutables.",
    ].join("\n");
  }
  return `Enfoque del rol:\n- Ajusta la respuesta al rol de proyecto \"${role}\" y mantenla alineada con el contexto compartido.`;
}

function configuredRoleGuidance(record: ProjectForSession): string | undefined {
  if (!record.role) {
    return roleGuidance(record.chat.role);
  }
  return nonEmptyLines([
    `Rol del chat: ${record.role.name}`,
    record.role.description ? `Descripcion del rol: ${record.role.description}` : undefined,
    record.role.instructions ? `Instrucciones del rol:\n${record.role.instructions}` : undefined,
  ]).join("\n\n");
}

function truncateProjectPromptContext(value: string): string {
  if (value.length <= PROJECT_PROMPT_CONTEXT_MAX_CHARS) {
    return value;
  }
  return `${value.slice(0, PROJECT_PROMPT_CONTEXT_MAX_CHARS - 80).trimEnd()}\n\n[project_context truncated]`;
}

export function buildProjectPromptContextFromRecord(
  record: ProjectForSession | null,
): string | undefined {
  if (!record) {
    return undefined;
  }
  const sections = nonEmptyLines([
    `Proyecto: ${record.project.name}`,
    record.project.description ? `Descripcion: ${record.project.description}` : undefined,
    record.chat.title ? `Chat de proyecto: ${record.chat.title}` : undefined,
    record.chat.role && !record.role ? `Rol del chat: ${record.chat.role}` : undefined,
    configuredRoleGuidance(record),
    record.context?.summary ? `Resumen:\n${record.context.summary}` : undefined,
    record.context?.instructions ? `Instrucciones:\n${record.context.instructions}` : undefined,
    bulletList("Decisiones", record.context?.decisions ?? []),
    projectDocumentList(record),
    bulletList("Documentos relevantes", record.context?.documents ?? []),
  ]);
  if (sections.length === 0) {
    return undefined;
  }
  return truncateProjectPromptContext(
    `<project_context>\n${sections.join("\n\n")}\n</project_context>`,
  );
}

export function buildProjectPromptContextForSession(params: {
  sessionKey?: string;
}): string | undefined {
  return buildProjectPromptContextFromRecord(getActiveProjectForSession(params.sessionKey));
}
