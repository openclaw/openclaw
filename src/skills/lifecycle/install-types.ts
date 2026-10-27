export type SkillInstallSkipReason = "brew" | "go" | "uv";

export type SkillInstallResult = {
  ok: boolean;
  message: string;
  stdout: string;
  stderr: string;
  code: number | null;
  skipReason?: SkillInstallSkipReason;
  warnings?: string[];
};
