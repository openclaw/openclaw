import type { RenderTableOptions, TableColumn } from "../../terminal/table.js";
type HeadingFn = (text: string) => string;
type TableRenderer = (input: RenderTableOptions) => string;
export type StatusReportSection = {
    kind: "lines";
    title: string;
    body: string[];
    skipIfEmpty?: boolean;
} | {
    kind: "table";
    title: string;
    width: number;
    renderTable: TableRenderer;
    columns: readonly TableColumn[];
    rows: Array<Record<string, string>>;
    trailer?: string | null;
    skipIfEmpty?: boolean;
} | {
    kind: "raw";
    body: string[];
    skipIfEmpty?: boolean;
};
export declare function appendStatusSectionHeading(params: {
    lines: string[];
    heading: HeadingFn;
    title: string;
}): void;
export declare function appendStatusLinesSection(params: {
    lines: string[];
    heading: HeadingFn;
    title: string;
    body: string[];
}): void;
export declare function appendStatusTableSection<Row extends Record<string, string>>(params: {
    lines: string[];
    heading: HeadingFn;
    title: string;
    width: number;
    renderTable: (input: {
        width: number;
        columns: TableColumn[];
        rows: Row[];
    }) => string;
    columns: readonly TableColumn[];
    rows: Row[];
}): void;
export declare function appendStatusReportSections(params: {
    lines: string[];
    heading: HeadingFn;
    sections: StatusReportSection[];
}): void;
export {};
