type NativeErrorDetails = {
  message: string;
  code?: string;
  errcode?: number;
};

export type NativeErrorResponse = NativeErrorDetails & {
  name: string;
  cause?: NativeErrorDetails;
};
