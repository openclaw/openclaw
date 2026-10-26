// Embedded menu triggers opt in explicitly; submenu items keep their native roving focus.
export const MENU_FORM_CONTROL_SELECTOR =
  ':is(input, textarea, select, [data-form-control], button, a[href]):not([role^="menuitem"]):not([aria-haspopup="menu"]:not([data-form-control]))';
