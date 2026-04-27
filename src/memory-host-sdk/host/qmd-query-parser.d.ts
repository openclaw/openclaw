export type QmdQueryResult = {
    docid?: string;
    score?: number;
    collection?: string;
    file?: string;
    snippet?: string;
    body?: string;
    startLine?: number;
    endLine?: number;
};
export declare function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[];
