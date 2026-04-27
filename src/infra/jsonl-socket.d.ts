/**
 * Sends one JSONL request line, half-closes the write side, and waits for an accepted response line.
 */
export declare function requestJsonlSocket<T>(params: {
    socketPath: string;
    requestLine: string;
    timeoutMs: number;
    accept: (msg: unknown) => T | null | undefined;
}): Promise<T | null>;
