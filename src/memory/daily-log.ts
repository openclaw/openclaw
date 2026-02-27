import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_DAILY_LOG_TEMPLATE = `# {{date}} - Daily Log

## Morning Notes

## Afternoon Progress

## Evening Reflection

## Key Learnings

## Action Items

## Links & References
`;

export const DEFAULT_CREATE_DAYS_AHEAD = 1;

export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function renderDailyLogTemplate(template: string, date: Date): string {
  return template.replaceAll("{{date}}", formatDate(date));
}

export function getDailyLogPath(workspaceDir: string, date: Date): string {
  return path.join(workspaceDir, "memory", `${formatDate(date)}.md`);
}

async function ensureMemoryDir(workspaceDir: string): Promise<void> {
  await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
}

function shiftDate(baseDate: Date, offsetDays: number): Date {
  const target = new Date(baseDate);
  target.setDate(target.getDate() + offsetDays);
  target.setHours(0, 0, 0, 0);
  return target;
}

export async function createDailyLogFile(params: {
  workspaceDir: string;
  date: Date;
  template: string;
}): Promise<{ created: boolean; path: string }> {
  const filePath = getDailyLogPath(params.workspaceDir, params.date);

  try {
    await fs.access(filePath);
    return { created: false, path: filePath };
  } catch {
    await ensureMemoryDir(params.workspaceDir);
    await fs.writeFile(filePath, renderDailyLogTemplate(params.template, params.date), "utf-8");
    return { created: true, path: filePath };
  }
}

export async function ensureDailyLogFiles(params: {
  workspaceDir: string;
  template?: string;
  createDaysAhead?: number;
  baseDate?: Date;
}): Promise<{ created: number; paths: string[] }> {
  const template = params.template ?? DEFAULT_DAILY_LOG_TEMPLATE;
  const createDaysAhead = params.createDaysAhead ?? DEFAULT_CREATE_DAYS_AHEAD;
  const baseDate = params.baseDate ?? new Date();
  const paths: string[] = [];
  let created = 0;

  for (let offset = 0; offset <= createDaysAhead; offset += 1) {
    const result = await createDailyLogFile({
      workspaceDir: params.workspaceDir,
      date: shiftDate(baseDate, offset),
      template,
    });
    paths.push(result.path);
    if (result.created) {
      created += 1;
    }
  }

  return { created, paths };
}
