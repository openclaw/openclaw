export type MessagePresentationChartSegment = {
  /** Category label shown in the chart legend. */
  label: string;
  /** Positive segment magnitude. */
  value: number;
};

export type MessagePresentationChartSeries = {
  /** Unique series name shown in the chart legend. */
  name: string;
  /** One finite value for each chart category, in category order. */
  values: number[];
};

export type MessagePresentationChartBlock =
  | {
      type: "chart";
      chartType: "pie";
      /** Short chart heading. */
      title: string;
      segments: MessagePresentationChartSegment[];
    }
  | {
      type: "chart";
      chartType: "bar" | "area" | "line";
      /** Short chart heading. */
      title: string;
      /** Ordered categories shared by every series. */
      categories: string[];
      series: MessagePresentationChartSeries[];
      xLabel?: string;
      yLabel?: string;
    };

/** Scalar cell value supported by portable table presentations. */
export type MessagePresentationTableCell = string | number;

/** Portable table rendered natively where supported and linearly elsewhere. */
export type MessagePresentationTableBlock = {
  type: "table";
  /** Short table heading used by native renderers and fallback text. */
  caption: string;
  /** Unique ordered column labels shared by every row. */
  headers: string[];
  /** Rows whose width exactly matches the header count. */
  rows: MessagePresentationTableCell[][];
  /** Optional column whose cells should be rendered as row headers. */
  rowHeaderColumnIndex?: number;
};
