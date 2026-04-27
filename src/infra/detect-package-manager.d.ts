export type DetectedPackageManager = "pnpm" | "bun" | "npm";
export declare function detectPackageManager(root: string): Promise<DetectedPackageManager | null>;
