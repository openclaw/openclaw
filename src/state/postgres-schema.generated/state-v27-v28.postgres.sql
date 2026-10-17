-- Generated v27-to-v28 publication after the local credential owner has verified and retired source rows.
UPDATE schema_meta SET schema_version = 28 WHERE meta_key = 'primary' AND schema_version = 27;
