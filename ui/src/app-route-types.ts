export type SolidRouteProps<Data = unknown> = {
  data: Data | undefined;
  loaderPending: boolean;
  presented: boolean;
};
