export declare const PACKAGE_DIST_INVENTORY_RELATIVE_PATH = "dist/postinstall-inventory.json";
export declare function collectPackageDistInventory(packageRoot: string): Promise<string[]>;
export declare function writePackageDistInventory(packageRoot: string): Promise<string[]>;
export declare function readPackageDistInventory(packageRoot: string): Promise<string[]>;
export declare function readPackageDistInventoryIfPresent(packageRoot: string): Promise<string[] | null>;
export declare function collectPackageDistInventoryErrors(packageRoot: string): Promise<string[]>;
