-- Generated v25-to-v26 publication after the local credential owner has verified and retired source rows.
UPDATE schema_meta SET schema_version = 26 WHERE meta_key = 'primary' AND schema_version = 25;
