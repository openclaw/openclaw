export type SystemdUserLingerStatus = {
    user: string;
    linger: "yes" | "no";
};
export declare function readSystemdUserLingerStatus(env: Record<string, string | undefined>): Promise<SystemdUserLingerStatus | null>;
export declare function enableSystemdUserLinger(params: {
    env: Record<string, string | undefined>;
    user?: string;
    sudoMode?: "prompt" | "non-interactive";
}): Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
    code: number;
}>;
