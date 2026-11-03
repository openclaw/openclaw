import { Errored, Loading, type Element } from "solid-js";

/** Optional plugin renderers share loading/error presentation without retiring their native fallback. */
export function ControlUiLazyView(props: { children: Element; fallback?: () => Element }) {
  return (
    <Errored
      fallback={(error) => (
        <>
          {props.fallback?.()}
          <span role="alert">{String(error())}</span>
        </>
      )}
    >
      <Loading fallback={props.fallback?.()}>{props.children}</Loading>
    </Errored>
  );
}
