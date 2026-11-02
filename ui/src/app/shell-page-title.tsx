import { createEffect, onSettled, useContext } from "solid-js";
import { ShellLayoutProvider } from "./shell-layout-traits-solid.tsx";

/** Names a subpage in the phone header, which otherwise shows its route's title. */
export function ShellPageTitle(props: { title: string }) {
  const scope = useContext(ShellLayoutProvider);
  if (scope) {
    createEffect(
      () => props.title,
      (title) => scope.owner.setPageTitle(title),
    );
    onSettled(() => () => scope.owner.setPageTitle(undefined));
  }
  return null;
}
