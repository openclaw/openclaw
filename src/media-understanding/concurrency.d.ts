export declare function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]>;
